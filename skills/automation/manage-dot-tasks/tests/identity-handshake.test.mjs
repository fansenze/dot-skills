/** Identity setup is tested against temporary state and an entirely local connector. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as m from '../scripts/taskctl.mjs';
import {digest} from '../scripts/connectors/contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE = fileURLToPath(new URL('./fixtures/connector.mjs', import.meta.url));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const options = fields => Object.entries(fields).flatMap(([key, value]) => value === undefined || value === false ? [] :
  value === true ? ['--' + key.replaceAll('_', '-')] : ['--' + key.replaceAll('_', '-'), String(value)]);
const setupFields = {id:'setup-one', connector:'fake-one', account:'account-one', brand:'feishu',
  authorization_ref:'trusted-dot:synthetic-request', grant_id:'grant-one', commands:'query,create,continue',
  tasks:'task-one', allow_new:true, updates:true, watch_id:'watch-one', initial:true};

function child(t, root, ...args) {
  return subprocess(t, [path.join(ROOT, 'scripts/taskctl.mjs'), '--store', root, ...args]);
}
function subprocess(t, args) {
  const proc = spawn(process.execPath, args, {stdio:['ignore','pipe','pipe']});
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    proc.stdout.on('data', b => stdout += b); proc.stderr.on('data', b => stderr += b);
    proc.on('error', reject); proc.on('close', (exit, signal) => resolve({exit, signal, stdout, stderr}));
  });
}

async function fixture(t, settingsExtra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-identity-handshake-'));
  const root = path.join(tmp, 'store'), external = path.join(tmp, 'external'), settings = path.join(tmp, 'settings.json');
  fs.mkdirSync(external); t.after(() => fs.rmSync(tmp, {recursive:true, force:true}));
  fs.writeFileSync(settings, JSON.stringify({root:external, account_id:'account-one', brand:'feishu', ...settingsExtra}));
  const call = (...args) => m.run(m.parse_args(['--store', root, ...args.map(String)]));
  await call('init'); await call('connect', '--id', 'fake-one', '--module', MODULE, '--settings-file', settings);
  const store = new m.Store(root), state = () => json(path.join(root, 'integration.json')), rows = [];
  const append = (...events) => { rows.push(...events); fs.writeFileSync(path.join(external, 'inbox.json'), JSON.stringify(rows)); };
  const ingest = async (...events) => { append(...events); return call('ingest', '--connector', 'fake-one'); };
  const begin = (fields = {}) => call('handshake-begin', ...options({...setupFields, ...fields}));
  const incoming = async (setup, fields = {}) => {
    while (Date.now() <= Date.parse(setup.issued_at)) await delay(2);
    const now = new Date().toISOString();
    return {event_id:'event-one', provider_event_id:fields.event_id ?? 'event-one', message_id:'message-one', account_id:'account-one', provider_app_id:'account-one', brand:'feishu',
      tenant_id:'tenant-one', sender_tenant_id:'tenant-one', sender_id:'sender-one', destination_id:'chat-one',
      chat_type:'p2p', sender_type:'user', type:'text', text:setup.challenge, native_text:setup.challenge,
      received_at:now, occurred_at:now, ...fields};
  };
  const grant = (fields = {}) => call('allow-inbound', ...options({id:'prior-grant', connector:'fake-one', account:'account-one',
    tenant:'tenant-one', sender:'sender-one', destination:'chat-one', mode:'agent', commands:'query', tasks:'none',
    since:'2000-01-01T00:00:00Z', ...fields}));
  const watch = (fields = {}) => call('watch', ...options({id:'prior-watch', connector:'fake-one', account:'account-one',
    destination:'chat-one', tasks:'none', events:'completed', ...fields}));
  const mutate = operation => store.locked(() => { const data = state(); operation(data); store.commit({'integration.json':m.encoded(data)}); });
  return {tmp, root, external, settings, call, store, state, rows, append, ingest, begin, incoming, grant, watch, mutate};
}

async function assertNoSetupEffects(f) {
  assert.deepEqual(f.state().grants, []); assert.deepEqual(f.state().watches, []); assert.deepEqual(f.state().outbox, []);
  assert.deepEqual((await f.call('message-next', '--consumer', 'test-agent')).messages, []);
  assert.deepEqual(await f.call('list', '--all'), []); assert.deepEqual(await f.call('queue'), []);
  assert.deepEqual(lines(path.join(f.external, 'calls.jsonl')), []);
}

test('one native private challenge establishes the exact preregistered scope and one overview without a task or receipt ack', async t => {
  const f = await fixture(t), setup = await f.begin({tasks:'none'});
  assert.equal(setup.state, 'pending'); assert.match(setup.challenge, /^dot-bind:[a-f0-9]{64}$/);
  assert.deepEqual(f.state().grants, []); assert.deepEqual(f.state().watches, []);
  const event = await f.incoming(setup); assert.equal((await f.ingest(event)).ingested, 1);
  const state = f.state(), status = await f.call('handshake-status', setup.id);
  assert.equal(status.state, 'consumed'); assert.equal(status.grant_id, 'grant-one'); assert.equal(status.watch_id, 'watch-one');
  assert.deepEqual(status.evidence, {account:'account-one', tenant:'tenant-one', sender:'sender-one', destination:'chat-one',
    brand:'feishu', provider_app_id:'account-one', provider_event_id:event.event_id, sender_tenant_id:'tenant-one', chat_type:'p2p', sender_type:'user', event_id:event.event_id,
    message_id:event.message_id, cursor:'1', occurred_at:event.occurred_at, received_at:event.received_at});
  assert.equal(state.grants.length, 1); assert.equal(state.watches.length, 1);
  assert.deepEqual(state.grants[0], {...setup.scope, account:'account-one', tenant:'tenant-one', sender:'sender-one',
    destination:'chat-one', since:event.received_at});
  assert.deepEqual(state.watches[0].tasks, []); assert.deepEqual(state.watches[0].events, ['completed']);
  assert.equal(state.inbox.length, 1); assert.equal(state.inbox[0].reason, 'handshake-consumed');
  assert.equal(state.inbox[0].mode, undefined); assert.equal(state.outbox.length, 1);
  assert.equal(state.outbox[0].event_id, 'initial:watch-one'); assert.equal(state.outbox[0].reply_to, null);
  assert.deepEqual((await f.call('message-next', '--consumer', 'test-agent')).messages, []);
  assert.deepEqual(await f.call('list', '--all'), []); assert.deepEqual(await f.call('queue'), []);
  await f.call('deliver', '--consumer', 'sender'); await f.call('deliver', '--consumer', 'sender');
  assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, 1);
  assert.equal(f.state().outbox[0].state, 'api_accepted');
});

test('the next ordinary authorized message follows agent intake with the scoped task context and its own receipt', async t => {
  const f = await fixture(t);
  for (const id of ['task-one', 'task-other']) await f.call('register', '--id', id, '--title', id, '--goal', 'Synthetic goal');
  const setup = await f.begin(), event = await f.incoming(setup); await f.ingest(event);
  assert.deepEqual(f.state().outbox[0].document.rows.map(row => row[0]), ['task-one']);
  const ordinary = await f.incoming(setup, {event_id:'event-two', message_id:'message-two', text:'Please continue the scoped task.', native_text:'Please continue the scoped task.'});
  await f.ingest(ordinary);
  const result = await f.call('start', '--consumer', 'active-agent', '--timeout-ms', '0');
  assert.equal(result.messages.length, 1); const claim = result.messages[0];
  assert.equal(claim.envelope.message_id, 'message-two'); assert.equal(claim.grant.id, 'grant-one');
  assert.deepEqual(claim.context.tasks.map(task => task.id), ['task-one']);
  assert.equal(claim.acknowledgement.state, 'api_accepted');
  assert.equal(f.state().outbox.length, 2); assert.match(f.state().outbox[1].event_id, /^received:/);
  assert.deepEqual(await f.call('queue'), []); assert.equal((await f.call('list', '--all')).length, 2);
});

test('setup survives a CLI restart and only the challenge hash is persisted or exposed by status', async t => {
  const f = await fixture(t);
  const issued = await child(t, f.root, 'handshake-begin', ...options(setupFields));
  assert.equal(issued.exit, 0, issued.stderr); const setup = JSON.parse(issued.stdout);
  const disk = fs.readFileSync(path.join(f.root, 'integration.json'), 'utf8');
  assert.ok(!disk.includes(setup.challenge)); assert.equal(f.state().handshakes[0].challenge_hash, digest(setup.challenge));
  const status = await child(t, f.root, 'handshake-status', 'setup-one');
  assert.equal(status.exit, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'pending');
  assert.ok(!status.stdout.includes(setup.challenge)); assert.ok(!status.stdout.includes('challenge_hash'));
  await assert.rejects(f.begin(), /already exists/);
  await assert.rejects(f.begin({id:'setup-two', grant_id:'grant-two', watch_id:'watch-two'}), /pending setup/);
  f.append(await f.incoming(setup));
  const resumed = await child(t, f.root, 'ingest', '--connector', 'fake-one');
  assert.equal(resumed.exit, 0, resumed.stderr); assert.equal((await f.call('handshake-status', 'setup-one')).state, 'consumed');
  const after = fs.readFileSync(path.join(f.root, 'integration.json'), 'utf8');
  assert.ok(!after.includes(setup.challenge)); assert.equal(f.state().handshakes[0].challenge_hash, digest(setup.challenge));
});

test('cancel is durable and idempotent, never releases an already issued setup ID, and permits a new authorized setup ID', async t => {
  const f = await fixture(t), setup = await f.begin();
  const cancelled = await child(t, f.root, 'handshake-cancel', setup.id);
  assert.equal(cancelled.exit, 0, cancelled.stderr); assert.equal(JSON.parse(cancelled.stdout).state, 'cancelled');
  assert.equal((await f.call('handshake-cancel', setup.id)).state, 'cancelled');
  await assert.rejects(f.begin(), /already exists/);
  const replacement = await f.begin({id:'setup-two'}); assert.notEqual(replacement.challenge, setup.challenge);
  await f.ingest(await f.incoming(setup)); assert.equal(f.state().inbox[0].reason, 'handshake-cancelled');
  await assertNoSetupEffects(f); assert.equal((await f.call('handshake-status', replacement.id)).state, 'pending');
});

test('expired setup without a grant stops transport reads and persists expiry across restart', async t => {
  const f = await fixture(t), setup = await f.begin();
  await f.mutate(data => { data.handshakes[0].issued_at = '2000-01-01T00:00:00Z'; data.handshakes[0].expires_at = '2000-01-01T00:01:00Z'; });
  fs.writeFileSync(path.join(f.external, 'inbox.json'), 'not valid JSON; reading this would fail');
  assert.equal((await f.call('ingest', '--connector', 'fake-one')).ingested, 0);
  const started = await f.call('start', '--consumer', 'test-agent', '--timeout-ms', '0');
  assert.equal(started.ingested, 0); assert.deepEqual(started.receive_gaps, []);
  assert.deepEqual(f.state().inbox, []); assert.deepEqual(f.state().checkpoints, []);
  const status = await child(t, f.root, 'handshake-status', setup.id);
  assert.equal(status.exit, 0, status.stderr); assert.equal(JSON.parse(status.stdout).state, 'expired');
  await assertNoSetupEffects(f);
});

const invalidEvidence = [
  ['group chat', () => ({chat_type:'group'})], ['missing chat type', () => ({chat_type:undefined})],
  ['rich post projection', h => ({type:'post', native_text:undefined, text_source:'post'})],
  ['nontext message', () => ({type:'image'})], ['missing native text evidence', () => ({native_text:undefined})],
  ['transformed native text', h => ({native_text:'@_bot ' + h.challenge})], ['omitted text', () => ({text_omitted:true})],
  ['reply parent', () => ({parent_id:'parent-one'})], ['reply root', () => ({root_id:'root-one'})], ['thread reply', () => ({thread_id:'thread-one'})],
  ['wrong app', () => ({account_id:'account-other'})], ['missing provider app evidence', () => ({provider_app_id:undefined})],
  ['wrong provider app evidence', () => ({provider_app_id:'account-other'})], ['wrong brand', () => ({brand:'lark'})],
  ['missing provider event evidence', () => ({provider_event_id:undefined})], ['mismatched provider event evidence', () => ({provider_event_id:'event-other'})],
  ['missing brand', () => ({brand:undefined})], ['missing sender', () => ({sender_id:undefined})],
  ['bot sender', () => ({sender_type:'app'})], ['missing sender type', () => ({sender_type:undefined})],
  ['missing sender tenant', () => ({sender_tenant_id:undefined})], ['sender tenant mismatch', () => ({sender_tenant_id:'tenant-other'})],
  ['whitespace sender', () => ({sender_id:' sender-one'})],
  ['missing provider timestamp', () => ({occurred_at:undefined})], ['null provider timestamp', () => ({occurred_at:null})],
  ['missing receive timestamp', () => ({received_at:undefined})], ['malformed receive timestamp', () => ({received_at:'not-a-time'})],
  ['old provider timestamp', () => ({occurred_at:'2000-01-01T00:00:00Z'})], ['old receive timestamp', () => ({received_at:'2000-01-01T00:00:00Z'})],
  ['timestamp equal to issuance', h => ({occurred_at:h.issued_at})],
  ['future provider timestamp', () => ({occurred_at:new Date(Date.now() + 60000).toISOString()})],
  ['future receive timestamp', () => ({received_at:new Date(Date.now() + 60000).toISOString()})],
];
for (const [name, fields] of invalidEvidence) test(`handshake rejects ${name} without broadening scope, sending, or creating work`, async t => {
  const f = await fixture(t), setup = await f.begin();
  await f.ingest(await f.incoming(setup, fields(setup)));
  assert.equal(f.state().inbox[0].reason, 'handshake-invalid-evidence');
  assert.equal((await f.call('handshake-status', setup.id)).state, 'pending');
  await assertNoSetupEffects(f);
});

test('challenge must be unchanged and reserved protocol replays never become task intake after setup', async t => {
  const f = await fixture(t), setup = await f.begin(), valid = await f.incoming(setup);
  const altered = {...valid, event_id:'event-altered', provider_event_id:'event-altered', message_id:'message-altered', text:setup.challenge+'\n', native_text:setup.challenge+'\n'};
  await f.ingest(altered); assert.equal(f.state().inbox[0].reason, 'handshake-unknown'); await assertNoSetupEffects(f);
  await f.ingest(valid, {...valid, event_id:'event-duplicate', provider_event_id:'event-duplicate'}, {...valid, event_id:'event-replay', provider_event_id:'event-replay', message_id:'message-replay'},
    {...valid, event_id:'event-unknown', provider_event_id:'event-unknown', message_id:'message-unknown', text:'dot-bind:'+'0'.repeat(64), native_text:'dot-bind:'+'0'.repeat(64)});
  assert.equal(f.state().grants.length, 1); assert.equal(f.state().watches.length, 1); assert.equal(f.state().outbox.length, 1);
  assert.equal(f.state().inbox.filter(row => row.reason === 'handshake-consumed' && row.status === 'accepted').length, 1);
  assert.equal(f.state().checkpoints[0].cursor, '5');
  assert.deepEqual((await f.call('message-next', '--consumer', 'test-agent')).messages, []);
  assert.deepEqual(await f.call('list', '--all'), []); assert.deepEqual(await f.call('queue'), []);
});

for (const [key, field] of [['tenant','tenant_id'], ['sender','sender_id'], ['destination','destination_id']]) {
  test(`pinned expected ${key} rejects a different tuple and accepts only the expected tuple`, async t => {
    const f = await fixture(t), expected = key === 'destination' ? 'chat-one' : key+'-one';
    const setup = await f.begin({[key]:expected});
    const wrong = {[field]:key+'-other', ...(key === 'tenant' ? {sender_tenant_id:'tenant-other'} : {})};
    await f.ingest(await f.incoming(setup, wrong)); await assertNoSetupEffects(f);
    await f.ingest(await f.incoming(setup, {event_id:'event-correct', message_id:'message-correct'}));
    assert.equal((await f.call('handshake-status', setup.id)).state, 'consumed');
    assert.equal(f.state().grants[0][key], expected);
  });
}

test('conflicting valid identities in one receive page fail closed before either tuple receives a grant', async t => {
  const f = await fixture(t), setup = await f.begin(), first = await f.incoming(setup);
  await f.ingest(first, {...first, event_id:'event-other', provider_event_id:'event-other', message_id:'message-other', sender_id:'sender-other', destination_id:'chat-other'});
  assert.equal((await f.call('handshake-status', setup.id)).state, 'conflict');
  assert.equal(f.state().inbox[0].reason, 'handshake-conflicting-identities'); assert.equal(f.state().checkpoints[0].cursor, '2');
  await assertNoSetupEffects(f);
});

test('multiple envelopes with the same valid tuple consume one setup and enqueue one overview', async t => {
  const f = await fixture(t), setup = await f.begin(), first = await f.incoming(setup);
  await f.ingest(first, {...first, event_id:'event-second', provider_event_id:'event-second', message_id:'message-second'});
  assert.equal(f.state().grants.length, 1); assert.equal(f.state().watches.length, 1); assert.equal(f.state().outbox.length, 1);
  assert.equal(f.state().inbox[1].reason, 'handshake-consumed'); assert.equal(f.state().inbox[1].status, 'rejected');
});

for (const disabled of [false, true]) for (const kind of ['grant', 'watch']) {
  test(`${disabled?'revoked':'existing'} ${kind} identity cannot be reenabled or broadened by a fresh challenge`, async t => {
    const f = await fixture(t); const policy = await f[kind]();
    if (disabled) await f.call(kind === 'grant' ? 'deny-inbound' : 'unwatch', policy.id);
    const before = structuredClone(kind === 'grant' ? f.state().grants : f.state().watches);
    await assert.rejects(f.begin({[kind === 'grant' ? 'grant_id' : 'watch_id']:policy.id}), /existing policies/);
    const setup = await f.begin({tasks:'all'}); await f.ingest(await f.incoming(setup));
    assert.equal((await f.call('handshake-status', setup.id)).state, 'conflict');
    assert.equal(f.state().inbox[0].reason, 'handshake-existing-policy-review-required');
    assert.deepEqual(kind === 'grant' ? f.state().grants : f.state().watches, before);
    assert.equal(f.state().grants.length, kind === 'grant' ? 1 : 0); assert.equal(f.state().watches.length, kind === 'watch' ? 1 : 0);
    assert.deepEqual(f.state().outbox, []); assert.deepEqual(await f.call('list', '--all'), []);
  });
}

test('a policy added after challenge issuance still fences setup against activation or escalation', async t => {
  const f = await fixture(t), setup = await f.begin(); await f.grant({id:'grant-one'}); await f.call('deny-inbound', 'grant-one');
  const before = structuredClone(f.state().grants); await f.ingest(await f.incoming(setup));
  assert.equal((await f.call('handshake-status', setup.id)).state, 'conflict');
  assert.deepEqual(f.state().grants, before); assert.deepEqual(f.state().watches, []); assert.deepEqual(f.state().outbox, []);
});

for (const disabled of [false, true]) test(`${disabled?'revoked':'existing'} watch cannot be bypassed by omitting watch-id and enabling grant updates`, async t => {
  const f = await fixture(t), watch = await f.watch();
  if (disabled) await f.call('unwatch', watch.id);
  const before = structuredClone(f.state().watches);
  const setup = await f.begin({watch_id:undefined, initial:false, updates:true});
  await f.ingest(await f.incoming(setup));
  assert.equal((await f.call('handshake-status', setup.id)).state, 'conflict');
  assert.equal(f.state().inbox[0].reason, 'handshake-existing-policy-review-required');
  assert.deepEqual(f.state().grants, []); assert.deepEqual(f.state().watches, before); assert.deepEqual(f.state().outbox, []);
});

test('a requested watch without the initial flag does not enqueue an implicit overview', async t => {
  const f = await fixture(t), setup = await f.begin({initial:false});
  await f.ingest(await f.incoming(setup));
  assert.equal((await f.call('handshake-status', setup.id)).state, 'consumed');
  assert.equal(f.state().watches.length, 1); assert.deepEqual(f.state().outbox, []);
});

test('an explicitly selected Lark binding requires and records Lark provenance', async t => {
  const f = await fixture(t, {brand:'lark'}), setup = await f.begin({brand:'lark'});
  await f.ingest(await f.incoming(setup)); await assertNoSetupEffects(f);
  await f.ingest(await f.incoming(setup, {brand:'lark', event_id:'event-lark', message_id:'message-lark'}));
  const status = await f.call('handshake-status', setup.id);
  assert.equal(status.state, 'consumed'); assert.equal(status.evidence.brand, 'lark');
});

test('existing checkpoint and rejected outcomes remain intact while a new setup records its baseline', async t => {
  const f = await fixture(t); await f.grant({sender:'sender-other'});
  const old = {issued_at:'2000-01-01T00:00:00Z', challenge:'ordinary unmatched message'};
  await f.ingest(await f.incoming(old)); await f.call('deny-inbound', 'prior-grant');
  const rejected = structuredClone(f.state().inbox[0]); assert.equal(rejected.status, 'rejected');
  const setup = await f.begin(); assert.equal(setup.baseline.cursor, '1');
  await f.ingest(await f.incoming(setup, {event_id:'event-new', message_id:'message-new'}));
  assert.equal((await f.call('handshake-status', setup.id)).state, 'consumed');
  assert.deepEqual(f.state().inbox[0], rejected); assert.equal(f.state().checkpoints[0].cursor, '2');
  assert.equal(f.state().grants.find(grant => grant.id === 'prior-grant').enabled, false);
  assert.equal(f.state().outbox.length, 1);
});

test('no-watch setup does not implicitly opt in to notifications or new-task creation', async t => {
  const f = await fixture(t), setup = await f.begin({commands:'query', allow_new:false, updates:false, tasks:'none', watch_id:undefined, initial:false});
  await f.ingest(await f.incoming(setup));
  assert.deepEqual(f.state().grants[0].commands, ['query']); assert.deepEqual(f.state().grants[0].tasks, []);
  assert.equal(f.state().grants[0].allow_new, false); assert.equal(f.state().grants[0].updates, false);
  assert.deepEqual(f.state().watches, []); assert.deepEqual(f.state().outbox, []);
  assert.equal((await f.call('handshake-cancel', setup.id)).state, 'consumed');
});

test('begin requires explicit valid authority, consistent app/brand, bounded lifetime, and supported capabilities', async t => {
  const f = await fixture(t);
  const invalid = [
    {authorization_ref:undefined}, {account:'wrong-app'}, {brand:'lark'}, {commands:'run'}, {commands:'query', allow_new:true},
    {commands:'create', allow_new:false}, {tasks:undefined}, {ttl_ms:999}, {ttl_ms:1800001}, {ttl_ms:'NaN'},
    {grant_id:'bad id'}, {watch_id:'grant-one'}, {watch_id:undefined, initial:true}, {reply_mode:'any'}, {format:'unknown'}, {language:'xx'},
  ];
  for (const fields of invalid) await assert.rejects(f.begin(fields));
  assert.deepEqual(f.state().handshakes, []); await assertNoSetupEffects(f);
  for (const [capability, settings] of [['receive',{receive:false}], ['durable',{durable_cursor:false}], ['reply',{reply:false}], ['send',{send:false}], ['format',{formats:['text']}]] ) {
    const g = await fixture(t, settings); await assert.rejects(g.begin(), /connector|required|format|watch/i, capability);
    assert.deepEqual(g.state().handshakes, []);
  }
});

test('concurrent real CLI consumers commit exactly one binding and overview, then independently restarted senders send once', async t => {
  const f = await fixture(t), setup = await f.begin(), event = await f.incoming(setup);
  f.append(event, {...event, event_id:'event-second', provider_event_id:'event-second', message_id:'message-second'});
  const results = await Promise.all(Array.from({length:6}, () => child(t, f.root, 'ingest', '--connector', 'fake-one')));
  for (const result of results) assert.ok(result.exit === 0 || /checkpoint advanced concurrently/.test(result.stdout + result.stderr), result.stdout + result.stderr);
  assert.ok(results.some(result => result.exit === 0)); await f.call('ingest', '--connector', 'fake-one');
  assert.equal(f.state().grants.length, 1); assert.equal(f.state().watches.length, 1); assert.equal(f.state().outbox.length, 1);
  assert.equal(f.state().inbox.filter(row => row.status === 'accepted').length, 1); assert.equal(f.state().checkpoints[0].cursor, '2');
  const sends = await Promise.all(Array.from({length:4}, (_, i) => child(t, f.root, 'deliver', '--consumer', 'worker-'+i)));
  for (const result of sends) assert.equal(result.exit, 0, result.stdout + result.stderr);
  assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, 1); assert.equal(f.state().outbox[0].state, 'api_accepted');
  assert.deepEqual(await f.call('list', '--all'), []); assert.deepEqual(await f.call('queue'), []);
});

for (const phase of ['journal', 'integration-write']) test(`SIGKILL after handshake ${phase} recovers binding, consumed evidence, checkpoint, and overview atomically`, async t => {
  const f = await fixture(t), setup = await f.begin(); f.append(await f.incoming(setup));
  const code = `import * as m from ${JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/taskctl.mjs')).href)};
    const original=m.Store.prototype.commit;
    m.Store.prototype.commit=function(writes){
      const state=writes['integration.json']&&JSON.parse(writes['integration.json']);
      if(state?.handshakes?.some(h=>h.state==='consumed')){
        m.atomic_write(this.path('.transaction.json'),m.encoded({schema_version:1,writes}));
        ${phase === 'integration-write' ? "m.atomic_write(this.path('integration.json'),writes['integration.json']);" : ''}
        process.kill(process.pid,'SIGKILL');
      }
      return original.call(this,writes);
    };
    await m.run(m.parse_args(['--store',${JSON.stringify(f.root)},'ingest','--connector','fake-one']));`;
  const crashed = await subprocess(t, ['--input-type=module', '-e', code]);
  assert.equal(crashed.signal, 'SIGKILL', crashed.stdout + crashed.stderr);
  assert.ok(fs.existsSync(path.join(f.root, '.transaction.json')));
  assert.equal((await f.call('doctor')).ok, true); await f.call('ingest', '--connector', 'fake-one');
  assert.equal((await f.call('handshake-status', setup.id)).state, 'consumed');
  assert.equal(f.state().grants.length, 1); assert.equal(f.state().watches.length, 1); assert.equal(f.state().outbox.length, 1);
  assert.equal(f.state().inbox.length, 1); assert.equal(f.state().inbox[0].reason, 'handshake-consumed');
  assert.equal(f.state().checkpoints[0].cursor, '1'); assert.ok(!fs.existsSync(path.join(f.root, '.transaction.json')));
  await f.call('deliver', '--consumer', 'recovery'); await f.call('deliver', '--consumer', 'recovery');
  assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, 1);
  assert.deepEqual(await f.call('list', '--all'), []); assert.deepEqual(await f.call('queue'), []);
});

for (const mode of ['malformed', 'throw-after-effect', 'crash-after-effect']) {
  test(`initial overview ${mode} remains unknown across restart and is never automatically resent`, async t => {
    const f = await fixture(t), setup = await f.begin(); await f.ingest(await f.incoming(setup));
    fs.writeFileSync(path.join(f.external, 'mode'), mode);
    const first = await child(t, f.root, 'deliver', '--consumer', 'first-sender');
    if (mode === 'crash-after-effect') {
      assert.equal(first.signal, 'SIGKILL');
      await f.mutate(data => { for (const notice of data.outbox) if (notice.lease) notice.lease.until = '2000-01-01T00:00:00Z'; });
    } else assert.equal(first.exit, 0, first.stderr);
    for (let i = 0; i < 2; i++) await f.call('start', '--consumer', 'recovery', '--timeout-ms', '0');
    const notice = f.state().outbox[0]; assert.equal(notice.state, 'delivery_unknown');
    assert.equal(lines(path.join(f.external, 'calls.jsonl')).length, 1); assert.equal(lines(path.join(f.external, 'effects.jsonl')).length, 1);
    assert.equal((await f.call('handshake-status', setup.id)).state, 'consumed');
    await assert.rejects(f.call('retry-notice', notice.id, '--reason', 'Unsafe automatic retry'), /reconcile/);
    assert.doesNotMatch(JSON.stringify(f.state()), /PRIVATE-DIAGNOSTIC/);
  });
}
