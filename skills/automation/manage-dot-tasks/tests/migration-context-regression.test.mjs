/** Migration preserves reviewed references without replaying old input or widening scope. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as m from '../scripts/taskctl.mjs';

test('reviewed replacement context preserves old receipt-task-session references with identity, scope and cutoff fences', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-context-regression-'));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const root = path.join(tmp, 'store'), external = path.join(tmp, 'external');
  fs.mkdirSync(external);
  const settings = path.join(tmp, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({root: external}));
  const call = (...args) => m.run(m.parse_args(['--store', root, ...args]));
  const store = new m.Store(root);
  const state = () => JSON.parse(fs.readFileSync(store.path('integration.json'), 'utf8'));
  const connector = name => call('connect', '--id', name, '--module', fileURLToPath(new URL('./fixtures/connector.mjs', import.meta.url)), '--settings-file', settings);
  const grant = (id, connectorId, fields = {}) => {
    const values = {id,connector:connectorId,account:'account-one',tenant:'tenant-one',sender:'sender-one',
      destination:'chat-one',mode:'agent',commands:'query,continue',tasks:'task-one',since:'2026-09-01T00:00:00Z',...fields};
    return call('allow-inbound', ...Object.entries(values).flatMap(([key,value]) => value === false ? [] : value === true ? ['--'+key] : ['--'+key,String(value)]));
  };
  const rows = [];
  const incoming = (n, extra = {}) => ({event_id:'event-'+n,message_id:'message-'+n,account_id:'account-one',tenant_id:'tenant-one',
    sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',text:'Synthetic request',
    received_at:'2026-10-01T00:00:00Z',occurred_at:'2026-10-01T00:00:00Z',...extra});
  const ingest = async (connectorId, ...messages) => {
    rows.push(...messages);
    fs.writeFileSync(path.join(external, 'inbox.json'), JSON.stringify(rows));
    return call('ingest', '--connector', connectorId);
  };
  const record = async (message, decision) => {
    const file = path.join(tmp, 'decision.json');
    fs.writeFileSync(file, JSON.stringify(decision));
    await call('message-record', message.id, '--token', message.token, '--decision-file', file);
    await call('message-ack', message.id, '--token', message.token);
  };
  await call('init');
  await call('register', '--id', 'task-one', '--title', 'Synthetic existing task', '--goal', 'Verify synthetic output');
  await call('bind', 'task-one', '--source', 'codex', '--source-ref', 'synthetic-session-one');
  await connector('old-connection');
  await grant('grant-one', 'old-connection', {since:'2026-01-01T00:00:00Z',updates:true});
  await call('watch', '--id', 'watch-old', '--connector', 'old-connection', '--account', 'account-one',
    '--destination', 'chat-one', '--tasks', 'task-one', '--events', 'completed');
  await ingest('old-connection', incoming(1, {received_at:'2026-06-01T00:00:00Z',occurred_at:'2026-06-01T00:00:00Z'}));
  const first = (await call('message-next', '--consumer', 'old-consumer')).messages[0];
  await record(first, {decision:'continue',summary:'Synthetic verified association',reply:'Synthetic accepted request',
    task_id:'task-one',work_revision:1,authorization_ref:'synthetic-user'});
  await call('update', 'task-one', '--status', 'executing', '--reason', 'Synthetic execution');
  await call('update', 'task-one', '--status', 'awaiting_verification', '--reason', 'Synthetic verification');
  await call('check', 'task-one', '--name', 'Acceptance', '--outcome', 'pass', '--evidence', 'Synthetic output');
  await call('complete', 'task-one', '--summary', 'Verified', '--evidence', 'Synthetic output');
  await call('deliver', '--consumer', 'old-sender');
  await store.locked(() => {
    const data = state(), notice = data.outbox.find(n => n.route.policy_id === 'watch-old');
    notice.receipt.message_id = 'old-bot-completion';
    notice.receipt.thread_id = 'old-thread';
    const unknown = data.outbox.find(n => n.event_id.startsWith('received:'));
    unknown.state = 'delivery_unknown';
    unknown.receipt = {status:'delivery_unknown',idempotency_key:unknown.key,retryable:false,
      message_id:'old-unknown',thread_id:'old-unknown-thread'};
    store.commit({'integration.json': m.encoded(data)});
  });
  await ingest('old-connection', incoming(2, {received_at:'2025-12-01T00:00:00Z',occurred_at:'2025-12-01T00:00:00Z',type:'post',text:'Legacy rejected body'}));
  const before = state();
  const oldCheckpoint = before.checkpoints.find(c => c.id === 'old-connection');
  const oldRejected = before.inbox.find(r => r.connector === 'old-connection' && r.status === 'rejected');
  const oldNoticeCount = before.outbox.length;
  await call('deny-inbound', 'grant-one');
  await call('unwatch', 'watch-old');
  await call('disconnect', 'old-connection');
  await connector('new-connection');

  for (const [field,value] of [['account','other-account'],['tenant','other-tenant'],['sender','other-sender'],['destination','other-chat']]) {
    await assert.rejects(grant('wrong-'+field, 'new-connection', {'context-from':'grant-one',[field]:value}), /identity|context|scope|conversation/i);
  }
  await grant('grant-new', 'new-connection', {'context-from':'grant-one'});
  await ingest('new-connection', incoming(3, {parent_id:'old-bot-completion',thread_id:'old-thread'}));
  const migrated = (await call('message-next', '--consumer', 'new-consumer')).messages[0];
  assert.equal(migrated.envelope.message_id, 'message-3');
  assert.ok(migrated.context.referenced_replies.some(r => r.message_id === 'old-bot-completion' && r.task_id === 'task-one'));
  assert.ok(migrated.context.referenced_messages.some(r => r.id === first.id && r.task_id === 'task-one'));
  assert.ok(migrated.context.source_bindings.some(b => b.task_id === 'task-one' && b.source === 'codex' && b.source_ref === 'synthetic-session-one'));
  assert.ok(!migrated.context.messages.some(r => r.id === first.id), 'Old history is explicit reference evidence, not general inherited conversation');
  assert.equal(migrated.task_id, null);
  let data = state();
  assert.deepEqual(data.checkpoints.find(c => c.id === 'old-connection'), oldCheckpoint);
  assert.deepEqual(data.inbox.find(r => r.id === oldRejected.id), oldRejected);
  assert.equal(data.inbox.filter(r => r.connector === 'new-connection' && r.status === 'rejected').length, 2);
  assert.equal(data.outbox.length, oldNoticeCount + 1, 'Only the genuinely new request receives an acknowledgement');
  assert.equal((await call('list', '--all')).length, 1);
  assert.deepEqual(await call('queue'), []);
  await record(migrated, {decision:'query',summary:'Synthetic status query',reply:'Synthetic status reply',task_id:'task-one'});

  await ingest('new-connection', incoming(4, {parent_id:'old-unknown',thread_id:'old-unknown-thread'}));
  const unknown = (await call('message-next', '--consumer', 'unknown-consumer')).messages[0];
  assert.deepEqual(unknown.context.referenced_replies, []);
  assert.deepEqual(unknown.context.referenced_messages, []);
  await record(unknown, {decision:'clarify',summary:'Unknown receipt is not association evidence',reply:'Please specify the task.'});

  await call('deny-inbound', 'grant-new');
  await grant('grant-no-context', 'new-connection');
  await ingest('new-connection', incoming(5, {parent_id:'old-bot-completion',thread_id:'old-thread'}));
  const unapprovedHistory = (await call('message-next', '--consumer', 'no-context-consumer')).messages[0];
  assert.deepEqual(unapprovedHistory.context.referenced_replies, []);
  assert.deepEqual(unapprovedHistory.context.referenced_messages, []);
  await record(unapprovedHistory, {decision:'clarify',summary:'Old context was not authorized',reply:'Please specify the task.'});
  await call('deny-inbound', 'grant-no-context');
  await grant('grant-narrow', 'new-connection', {'context-from':'grant-one',commands:'query',tasks:'none'});
  await ingest('new-connection', incoming(6, {parent_id:'old-bot-completion',thread_id:'old-thread'}));
  const narrow = (await call('message-next', '--consumer', 'narrow-consumer')).messages[0];
  assert.deepEqual(narrow.context.referenced_replies, []);
  assert.deepEqual(narrow.context.referenced_messages, []);
  assert.deepEqual(narrow.context.tasks, []);
  assert.deepEqual(narrow.context.source_bindings, []);
  assert.equal((await call('doctor')).ok, true);
});
