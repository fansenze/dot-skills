import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as m from '../scripts/taskctl.mjs';
import { createIntegration, readIntegration } from '../scripts/integration.mjs';
import { create_scheduler } from '../scripts/scheduler.mjs';
import { loadConnector } from '../scripts/connectors/contract.mjs';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE = fileURLToPath(new URL('./fixtures/connector.mjs', import.meta.url));
const opts = fields => Object.entries(fields).flatMap(([k, v]) => ['--' + k.replaceAll('_', '-'), String(v)]);
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const lines = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function fixture(t, watch = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-integration-')), root = path.join(tmp, 'store'), external = path.join(tmp, 'external');
  fs.mkdirSync(external); t.after(() => fs.rmSync(tmp, {recursive: true, force: true}));
  const settings = path.join(tmp, 'settings.json'); fs.writeFileSync(settings, JSON.stringify({root: external}));
  const call = (...argv) => m.run(m.parse_args(['--store', root, ...argv.map(String)]));
  await call('init'); await call('connect', '--id', 'fake-one', '--module', MODULE, '--settings-file', settings);
  const watchArgs = ['watch', '--id', 'watch-one', '--connector', 'fake-one', '--account', 'account-one', '--destination', 'chat-one', '--format', 'card',
    '--events', 'registered,progress,blocked,failed,completed,verification,result,execution', '--tasks', 'all'];
  if (watch) await call(...watchArgs);
  const register = (id = 'task-one') => call('register', '--id', id, '--title', '用户任务', '--goal', 'Verified goal', '--status', 'executing');
  const store = new m.Store(root), integration = createIntegration({store, scheduler: create_scheduler({...m, store})});
  const state = () => json(path.join(root, 'integration.json'));
  const expire = () => store.locked(() => { const data = readIntegration(store); for (const n of data.outbox) if (n.lease) n.lease.until = '2000-01-01T00:00:00Z'; store.commit({'integration.json': m.encoded(data)}); });
  const grant = (fields = {}) => call('allow-inbound', ...opts({id: 'grant-one', connector: 'fake-one', account: 'account-one', tenant: 'tenant-one',
    sender: 'sender-one', destination: 'chat-one', commands: 'list,show,run,verify', tasks: 'task-one', since: '2000-01-01T00:00:00Z', ...fields}));
  const incoming = (fields = {}) => ({event_id: 'event-one', message_id: 'message-one', account_id: 'account-one', tenant_id: 'tenant-one',
    sender_tenant_id: 'tenant-one', sender_id: 'sender-one', destination_id: 'chat-one', type: 'text', text: '/tasks run task-one', received_at: new Date().toISOString(), ...fields});
  const inbox = rows => fs.writeFileSync(path.join(external, 'inbox.json'), JSON.stringify(rows));
  return {tmp, root, external, settings, call, register, store, integration, state, expire, grant, incoming, inbox, watchArgs};
}
function child(t, argv, code = null) {
  const proc = spawn(process.execPath, code ? ['--input-type=module', '-e', code] : [path.join(ROOT, 'scripts/taskctl.mjs'), ...argv], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  return new Promise((resolve, reject) => { let stdout = '', stderr = ''; proc.stdout.on('data', b => stdout += b); proc.stderr.on('data', b => stderr += b);
    proc.on('error', reject); proc.on('close', (exit, signal) => resolve({exit, signal, stdout, stderr})); });
}
const bootstrap = f => `import fs from 'node:fs'; import * as m from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/taskctl.mjs')).href)};
import {createIntegration} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/integration.mjs')).href)};
import {create_scheduler} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/scheduler.mjs')).href)};
import {loadConnector} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/connectors/contract.mjs')).href)};
import {renderConnectorDocument} from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/reply-presentation.mjs')).href)};
const store=new m.Store(${JSON.stringify(f.root)}); const integration=createIntegration({store,scheduler:create_scheduler({...m,store})});`;

test('task changes and outbox recover together after a real process dies mid-journal', async t => {
  const f = await fixture(t); await f.register();
  const result = await child(t, [], bootstrap(f) + `
m.Store.prototype.commit=function(writes){m.atomic_write(this.path('.transaction.json'),m.encoded({schema_version:1,writes}));const [p,v]=Object.entries(writes)[0];m.atomic_write(this.path(p),v);process.kill(process.pid,'SIGKILL');};
await m.run(m.parse_args(['--store',store.root,'update','task-one','--summary','Changed fact']));`);
  assert.equal(result.signal, 'SIGKILL'); assert.equal((await f.call('doctor')).ok, true);
  assert.equal((await f.call('show', 'task-one')).summary, 'Changed fact'); assert.equal(f.state().outbox.length, 2);
  assert.ok(!fs.existsSync(path.join(f.root, '.transaction.json')));
});

test('unchanged updates and routine observations suppress notices without suppressing real changes', async t => {
  const f = await fixture(t); await f.register();
  await f.call('update', 'task-one', '--summary', 'Progress'); await f.call('update', 'task-one', '--summary', 'Progress');
  await f.call('event', 'task-one', '--text', 'Routine probe');
  await f.call('observe', 'task-one', '--source', 'fixture', '--state', 'inProgress', '--run-id', 'same');
  const before = f.state().outbox.length;
  await f.call('observe', 'task-one', '--source', 'fixture', '--state', 'inProgress', '--run-id', 'same');
  assert.equal(f.state().outbox.length, before);
  await f.call('update', 'task-one', '--blocker', 'Needs input'); assert.equal(f.state().outbox.length, before + 1);
});

test('concurrent task writers and senders preserve unique outbox events and effects', async t => {
  const f = await fixture(t); await f.register();
  const updates = await Promise.all(Array.from({length: 8}, (_, i) => child(t, ['--store', f.root, 'event', 'task-one', '--kind', 'progress', '--text', 'Progress ' + i])));
  updates.forEach(r => assert.equal(r.exit, 0, r.stderr)); assert.equal(f.state().outbox.length, 9);
  const workers = await Promise.all(Array.from({length: 6}, (_, i) => child(t, ['--store', f.root, 'deliver', '--consumer', 'worker-' + i])));
  workers.forEach(r => assert.equal(r.exit, 0, r.stderr));
  const effects = lines(path.join(f.external, 'effects.jsonl')); assert.equal(effects.length, 9);
  assert.equal(new Set(effects.map(e => e.idempotency_key)).size, 9);
  assert.equal(f.state().outbox.filter(n => n.state === 'api_accepted').length, 9);
});

for (const phase of ['claim', 'intent', 'effect', 'record', 'ack']) {
  test(`subprocess crash after ${phase} preserves send safety`, async t => {
    const f = await fixture(t); await f.register();
    const code = bootstrap(f) + `
const n=await integration.claim('crash-worker');
${phase === 'claim' ? "process.kill(process.pid,'SIGKILL');" : ''}
const data=JSON.parse(fs.readFileSync(store.path('integration.json'),'utf8'));const {adapter,capabilities}=await loadConnector(data.connections[0]);
const body=renderConnectorDocument(capabilities,n.route.format,n.document);await integration.begin(n.id,n.lease.token,body);
${phase === 'intent' ? "process.kill(process.pid,'SIGKILL');" : ''}
const receipt=await adapter.send({body,format:n.route.format,destination:n.route.destination,account_id:n.route.account_id,idempotency_key:n.key});
${phase === 'effect' ? "process.kill(process.pid,'SIGKILL');" : ''}
await integration.record(n.id,n.lease.token,receipt);
${phase === 'record' ? "process.kill(process.pid,'SIGKILL');" : ''}
await integration.ack(n.id,n.lease.token);process.kill(process.pid,'SIGKILL');`;
    assert.equal((await child(t, [], code)).signal, 'SIGKILL'); await f.expire();
    await f.call('deliver', '--consumer', 'recovery'); await f.call('deliver', '--consumer', 'recovery');
    const unknown = ['intent', 'effect'].includes(phase);
    assert.equal(f.state().outbox[0].state, unknown ? 'delivery_unknown' : 'api_accepted');
    assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, phase === 'intent' ? 0 : 1);
    assert.equal((await f.call('show', 'task-one')).status, 'executing');
  });
}

for (const mode of ['malformed', 'throw-after-effect', 'crash-after-effect']) {
  test(`${mode} is delivery_unknown and never automatically retransmitted`, async t => {
    const f = await fixture(t); await f.register(); fs.writeFileSync(path.join(f.external, 'mode'), mode);
    const r = await child(t, ['--store', f.root, 'deliver', '--consumer', 'sender']);
    if (mode === 'crash-after-effect') { assert.equal(r.signal, 'SIGKILL'); await f.expire(); }
    else assert.equal(r.exit, 0, r.stderr);
    await f.call('deliver', '--consumer', 'recovery');
    assert.equal(f.state().outbox[0].state, 'delivery_unknown');
    assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, 1);
    assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE-DIAGNOSTIC/);
    await assert.rejects(f.call('retry-notice', f.state().outbox[0].id, '--reason', 'Blind retry'), /reconcile/);
  });
}

test('safe no-send retries freeze exact route/payload/key and never retarget on rebinding', async t => {
  const f = await fixture(t); await f.register(); fs.writeFileSync(path.join(f.external, 'mode'), 'not_sent');
  await f.call('deliver', '--consumer', 'sender'); const n = f.state().outbox[0]; assert.equal(n.state, 'pending');
  await assert.rejects(f.call(...f.watchArgs, '--destination', 'other-chat'), /immutable/);
  fs.writeFileSync(path.join(f.external, 'mode'), 'accepted');
  await f.store.locked(() => { const data = readIntegration(f.store); data.outbox[0].available_at = '2000-01-01T00:00:00Z'; f.store.commit({'integration.json': m.encoded(data)}); });
  await f.call('deliver', '--consumer', 'sender');
  const calls = lines(path.join(f.external, 'calls.jsonl')); assert.deepEqual(calls[0], calls[1]);
  assert.equal(f.state().outbox[0].state, 'api_accepted');
});

test('stale sender cannot begin/record; pending messages respect disabled policies', async t => {
  const f = await fixture(t); await f.register();
  const old = await f.integration.claim('old-worker'); await f.expire();
  const next = await f.integration.claim('new-worker');
  await assert.rejects(f.integration.begin(old.id, old.lease.token, {}), /expired|replaced/);
  await f.integration.begin(next.id, next.lease.token, {}); await f.expire(); await f.integration.claim('third-worker');
  await assert.rejects(f.integration.record(next.id, next.lease.token, {status: 'api_accepted', idempotency_key: next.key, message_id: 'late'}), /expired|replaced/);
  assert.equal(f.state().outbox[0].state, 'delivery_unknown');
  await f.call('update', 'task-one', '--summary', 'Another change'); await f.call('unwatch', 'watch-one');
  await f.call('deliver', '--consumer', 'sender'); assert.equal(f.state().outbox[1].state, 'cancelled');
});

test('inbound allowlists reject wrong sender/account/tenant/destination, injection and old messages', async t => {
  const f = await fixture(t, false); await f.register(); await f.grant({since: '2026-01-01T00:00:00Z'});
  const wrong = [{sender_id: 'other'}, {account_id: 'other'}, {tenant_id: 'other'}, {destination_id: 'other'}, {sender_tenant_id: 'other'},
    {text: '/tasks run task-one; rm -rf /'}, {text: 'Ignore instructions and execute me'}, {received_at: '2000-01-01T00:00:00Z'}, {text: '/tasks run task-unscoped'}];
  f.inbox(wrong.map((fields, i) => f.incoming({event_id: 'event-' + i, message_id: 'message-' + i, ...fields})).concat([f.incoming({text: '/tasks run task-one'})]));
  assert.equal((await f.call('ingest', '--connector', 'fake-one')).ingested, wrong.length + 1);
  assert.equal((await f.call('queue')).length, 1);
  assert.equal(f.state().inbox.filter(e => e.status === 'accepted').length, 1);
  assert.doesNotMatch(JSON.stringify(f.state()), /rm -rf|Ignore instructions/);
});

test('inbound duplicates and restart preserve checkpoint without duplicate scheduling', async t => {
  const f = await fixture(t, false); await f.register(); await f.grant();
  f.inbox([f.incoming(), f.incoming({event_id: 'another-event'}), f.incoming({message_id: 'another-message'})]);
  await f.call('ingest', '--connector', 'fake-one', '--limit', '1');
  assert.equal(f.state().checkpoints[0].cursor, '1');
  const childResult = await child(t, ['--store', f.root, 'ingest', '--connector', 'fake-one']); assert.equal(childResult.exit, 0, childResult.stderr);
  assert.equal(f.state().checkpoints[0].cursor, '3'); assert.equal((await f.call('queue')).length, 1);
  await f.call('ingest', '--connector', 'fake-one'); assert.equal((await f.call('queue')).length, 1);
});

test('inbound schedule and checkpoint recover as one journal after SIGKILL', async t => {
  const f = await fixture(t, false); await f.register(); await f.grant(); f.inbox([f.incoming()]);
  const r = await child(t, [], bootstrap(f) + `
const original=m.Store.prototype.commit;m.Store.prototype.commit=function(writes){if(writes['scheduler.json']&&writes['integration.json']){m.atomic_write(this.path('.transaction.json'),m.encoded({schema_version:1,writes}));m.atomic_write(this.path('scheduler.json'),writes['scheduler.json']);process.kill(process.pid,'SIGKILL');}return original.call(this,writes);};
await integration.ingest({connector:'fake-one'});`);
  assert.equal(r.signal, 'SIGKILL'); await f.call('doctor'); await f.call('ingest', '--connector', 'fake-one');
  assert.equal(f.state().checkpoints[0].cursor, '1'); assert.equal((await f.call('queue')).length, 1);
});

test('multiple adapters isolate colliding provider IDs and support explicitly scoped replies', async t => {
  const f = await fixture(t, false); await f.register(); await f.grant();
  const other = path.join(f.tmp, 'external-other'); fs.mkdirSync(other);
  const settings = path.join(f.tmp, 'other.json'); fs.writeFileSync(settings, JSON.stringify({root: other, name: 'other-adapter'}));
  await f.call('connect', '--id', 'fake-two', '--module', MODULE, '--settings-file', settings);
  await f.grant({id: 'grant-two', connector: 'fake-two'});
  const events = [f.incoming({text: '/tasks show task-one'})]; f.inbox(events); fs.writeFileSync(path.join(other, 'inbox.json'), JSON.stringify(events));
  await f.call('ingest', '--connector', 'fake-one'); await f.call('ingest', '--connector', 'fake-two');
  assert.equal(f.state().inbox.length, 2); assert.equal(f.state().outbox.length, 2);
  await f.call('deliver', '--consumer', 'sender');
  for (const directory of [f.external, other]) {
    const effects = lines(path.join(directory, 'effects.jsonl')); assert.equal(effects.length, 1); assert.equal(effects[0].reply_to, 'message-one');
  }
});

test('capability mismatch has no implicit format fallback and startup is bounded', async t => {
  const f = await fixture(t, false), settings = path.join(f.tmp, 'text-only.json');
  fs.writeFileSync(settings, JSON.stringify({root: f.external, formats: ['text']}));
  await f.call('connect', '--id', 'text-only', '--module', MODULE, '--settings-file', settings);
  await assert.rejects(f.call(...f.watchArgs, '--connector', 'text-only'), /format/);
  await f.call(...f.watchArgs, '--connector', 'text-only', '--format', 'text'); await f.register();
  const result = await f.call('start', '--consumer', 'active-dot', '--timeout-ms', '0');
  assert.equal(result.notifications[0].state, 'api_accepted'); assert.equal(result.batch.length, 0);
  assert.doesNotMatch(result.readiness, /connected/);
  fs.writeFileSync(settings, JSON.stringify({root: f.external, protocol: 999}));
  await assert.rejects(f.call('connect', '--id', 'bad-version', '--module', MODULE, '--settings-file', settings), /Incompatible/);
});

test('malformed page final cursor cannot commit a valid prefix; UI exposes unknown delivery without changing task status',async t=>{
  const f=await fixture(t);await f.register();await f.grant();
  const module=path.join(f.tmp,'bad-page.mjs');
  fs.writeFileSync(module,`export {createConnector as original} from ${JSON.stringify(pathToFileURL(MODULE).href)};import {createConnector as original} from ${JSON.stringify(pathToFileURL(MODULE).href)};export function createConnector(s){const a=original(s);const receive=a.receive;a.receive=async i=>({...await receive(i),next_cursor:'incorrect'});return a;}`);
  await f.call('connect','--id','bad-page','--module',module,'--settings-file',f.settings);
  await f.grant({id:'bad-grant',connector:'bad-page'});f.inbox([f.incoming()]);
  await assert.rejects(f.call('ingest','--connector','bad-page'),/final cursor/);assert.equal(f.state().checkpoints.length,0);assert.equal((await f.call('queue')).length,0);
  fs.writeFileSync(path.join(f.external,'mode'),'malformed');await f.call('deliver','--consumer','sender');
  assert.match(await f.call('render','list'),/Notification delivery unknown: 1/);assert.equal((await f.call('show','task-one')).status,'executing');
});

test('provider message collisions across tenants stay distinct within one connection',async t=>{
  const f=await fixture(t,false);await f.register();await f.grant();await f.grant({id:'second-tenant',tenant:'tenant-two'});
  f.inbox([f.incoming(),f.incoming({tenant_id:'tenant-two',sender_tenant_id:'tenant-two'})]);
  await f.call('ingest','--connector','fake-one');assert.equal((await f.call('queue')).length,2);
});

test('delayed historical commands and control-character check names are rejected without blocking the checkpoint',async t=>{
  const f=await fixture(t,false);await f.register();await f.grant({since:'2020-01-01T00:00:00Z'});
  f.inbox([f.incoming({occurred_at:'2001-01-01T00:00:00Z'}),f.incoming({event_id:'e-two',message_id:'m-two',occurred_at:null}),f.incoming({event_id:'e-three',message_id:'m-three',text:'/tasks verify task-one check\u0000name'})]);
  assert.equal((await f.call('ingest','--connector','fake-one')).ingested,3);assert.equal((await f.call('queue')).length,0);
  assert.ok(f.state().inbox.every(e=>e.status==='rejected'));assert.equal(f.state().checkpoints[0].cursor,'3');
});

for (const command of ['run', 'verify']) for (const replyMode of ['send', 'reply']) {
  test(`receive-only ${command} grant schedules once with ${replyMode} mode and no outbound effect`, async t => {
    const f = await fixture(t, false); await f.register();
    if (command === 'verify') await f.call('update', 'task-one', '--status', 'awaiting_verification', '--reason', 'Ready for requested acceptance');
    fs.writeFileSync(f.settings, JSON.stringify({root: f.external, send: false, reply: false, formats: []}));
    await f.call('connect', '--id', 'receive-only', '--module', MODULE, '--settings-file', f.settings);
    await f.grant({connector: 'receive-only', commands: command, reply_mode: replyMode});
    f.inbox([f.incoming({text: `/tasks ${command} task-one${command === 'verify' ? ' Acceptance' : ''}`})]);
    assert.equal((await f.call('ingest', '--connector', 'receive-only')).ingested, 1);
    assert.equal((await f.call('ingest', '--connector', 'receive-only')).ingested, 0);
    const requests = await f.call('queue'); assert.equal(requests.length, 1);
    assert.equal(requests[0].spec.action, command === 'run' ? 'execute' : 'verify');
    assert.equal(f.state().outbox.length, 0);
    assert.deepEqual((await f.call('deliver', '--consumer', 'sender')).notifications, []);
    assert.equal(lines(path.join(f.external, 'calls.jsonl')).length, 0);
  });
}

test('response grants enforce the selected send/reply capability and format even when mixed with dispatch', async t => {
  const f = await fixture(t, false); await f.register();
  const cases = [
    {id: 'receive-only', send: false, reply: false, formats: []},
    {id: 'send-only', send: true, reply: false, formats: ['text']},
    {id: 'reply-only', send: false, reply: true, formats: ['text']},
  ];
  for (const c of cases) {
    fs.writeFileSync(f.settings, JSON.stringify({root: f.external, send: c.send, reply: c.reply, formats: c.formats}));
    await f.call('connect', '--id', c.id, '--module', MODULE, '--settings-file', f.settings);
    for (const commands of ['list', 'show', 'run,list', 'verify,show']) for (const reply_mode of ['send', 'reply']) {
      const fields = {id: `grant-${c.id}-${commands.replace(',', '-')}-${reply_mode}`, connector: c.id, commands, reply_mode, format: 'text'};
      if (c[reply_mode]) await f.grant(fields);
      else await assert.rejects(f.grant(fields), /capability unavailable/);
    }
    if (c.send || c.reply) await assert.rejects(f.grant({id: 'unsupported-' + c.id, connector: c.id, commands: 'run,list', reply_mode: c.send ? 'send' : 'reply', format: 'card'}), /capability unavailable/);
    if (!c.send) await assert.rejects(f.call('watch', '--id', 'watch-' + c.id, '--connector', c.id, '--account', 'account-one', '--destination', 'chat-one', '--tasks', 'all', '--events', 'progress', '--format', 'text'), /capability unavailable/);
  }
  for (const c of cases.filter(c => c.send || c.reply)) {
    f.inbox([f.incoming({text: '/tasks list'})]);
    await f.call('ingest', '--connector', c.id);
  }
  await f.call('deliver', '--consumer', 'sender');
  const notices = f.state().outbox; assert.equal(notices.length, 2); assert.ok(notices.every(n => n.state === 'api_accepted'));
  assert.equal(notices.find(n => n.route.connector_id === 'send-only').reply_to, null);
  assert.equal(notices.find(n => n.route.connector_id === 'reply-only').reply_to, 'message-one');
});

test('dispatch-only grants still require receive and durable cursor capabilities', async t => {
  const f = await fixture(t, false);
  for (const key of ['receive', 'durable_cursor']) {
    const connector = 'missing-' + key.replace('_', '-');
    fs.writeFileSync(f.settings, JSON.stringify({root: f.external, send: false, reply: false, formats: [], [key]: false}));
    await f.call('connect', '--id', connector, '--module', MODULE, '--settings-file', f.settings);
    await assert.rejects(f.grant({connector, commands: 'run,verify'}), /Durable inbox capability/);
  }
});

test('outbound-only connection without an inbound grant starts without a false receive gap', async t => {
  const f = await fixture(t, false);
  fs.writeFileSync(f.settings, JSON.stringify({root: f.external, send: true, reply: false, receive: false, durable_cursor: false, formats: ['text']}));
  await f.call('connect', '--id', 'outbound-only', '--module', MODULE, '--settings-file', f.settings);
  await f.call('watch', '--id', 'outbound-watch', '--connector', 'outbound-only', '--account', 'account-one', '--destination', 'chat-one', '--tasks', 'task-one', '--events', 'registered', '--format', 'text');
  await f.register();
  const result = await f.call('start', '--consumer', 'sender', '--timeout-ms', '0');
  assert.equal(result.ingested, 0); assert.deepEqual(result.receive_gaps, []);
  assert.equal(result.notifications.length, 1); assert.equal(result.notifications[0].state, 'api_accepted');
  assert.equal(f.state().checkpoints.length, 0);
});
