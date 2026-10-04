/** Completion-watch receipts must remain usable as scoped conversation evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as m from '../scripts/taskctl.mjs';

test('followup to a watched completion recovers its original task beyond recent history', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-reference-regression-'));
  t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const root = path.join(tmp, 'store'), external = path.join(tmp, 'external');
  fs.mkdirSync(external);
  const settings = path.join(tmp, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({root: external}));
  const call = (...args) => m.run(m.parse_args(['--store', root, ...args]));
  const store = new m.Store(root);
  const read = () => JSON.parse(fs.readFileSync(store.path('integration.json'), 'utf8'));
  const rows = [];
  const intake = async (n, extra = {}) => {
    rows.push({event_id:'event-'+n,message_id:'message-'+n,account_id:'account-one',tenant_id:'tenant-one',
      sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',
      text:'Synthetic request',received_at:new Date().toISOString(),...extra});
    fs.writeFileSync(path.join(external, 'inbox.json'), JSON.stringify(rows));
    await call('ingest', '--connector', 'fake-one');
    return (await call('message-next', '--consumer', 'reviewer')).messages[0];
  };
  const record = async (message, decision) => {
    const file = path.join(tmp, 'decision.json');
    fs.writeFileSync(file, JSON.stringify(decision));
    const result = await call('message-record', message.id, '--token', message.token, '--decision-file', file);
    await call('message-ack', message.id, '--token', message.token);
    return result;
  };
  await call('init');
  await call('connect', '--id', 'fake-one', '--module', fileURLToPath(new URL('./fixtures/connector.mjs', import.meta.url)), '--settings-file', settings);
  await call('allow-inbound', '--id', 'grant-one', '--connector', 'fake-one', '--account', 'account-one',
    '--tenant', 'tenant-one', '--sender', 'sender-one', '--destination', 'chat-one', '--mode', 'agent',
    '--commands', 'query,create,continue', '--tasks', 'none', '--allow-new', '--updates', '--since', '2000-01-01T00:00:00Z');
  await call('watch', '--id', 'watch-one', '--connector', 'fake-one', '--account', 'account-one',
    '--destination', 'chat-one', '--tasks', 'all', '--events', 'completed');
  const first = await intake(1);
  const {task_id: task} = await record(first, {decision:'create',title:'Synthetic task',goal:'Synthetic goal',
    next_action:'Review synthetic output',summary:'Verified request',reply:'Working on it',authorization_ref:'synthetic-user'});
  await call('bind', task, '--source', 'codex', '--source-ref', 'synthetic-session');
  await call('update', task, '--status', 'executing', '--reason', 'Synthetic execution');
  await call('update', task, '--status', 'awaiting_verification', '--reason', 'Synthetic verification');
  await call('check', task, '--name', 'Acceptance', '--outcome', 'pass', '--evidence', 'Synthetic output');
  await call('complete', task, '--summary', 'Verified', '--evidence', 'Synthetic output');
  await call('deliver', '--consumer', 'sender');
  await store.locked(() => {
    const data = read(), completion = data.outbox.find(n => n.route.policy_id === 'watch-one');
    assert.equal(completion.reply_to, 'message-1');
    completion.receipt.message_id = 'bot-completion';
    completion.receipt.thread_id = 'thread-completion';
    store.commit({'integration.json': m.encoded(data)});
  });
  for (let i = 2; i <= 23; i++) await record(await intake(i), {decision:'query',summary:'Unassociated query',reply:'Synthetic answer'});
  const follow = await intake(24, {parent_id:'bot-completion',thread_id:'thread-completion',text:'What is the result of this task?'});
  assert.ok(!follow.context.messages.some(r => r.id === first.id));
  assert.ok(follow.context.referenced_replies.some(r => r.message_id === 'bot-completion' && r.task_id === task));
  assert.ok(follow.context.referenced_messages.some(r => r.id === first.id && r.task_id === task));
  assert.ok(follow.context.source_bindings.some(b => b.task_id === task && b.source === 'codex' && b.source_ref === 'synthetic-session'));
  assert.equal(follow.task_id, null);
  assert.deepEqual(await call('queue'), []);
});
