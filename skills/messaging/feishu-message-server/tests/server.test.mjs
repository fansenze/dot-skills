import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, fromMapping, initialize, loadConfig, checkConfig, prepareConfig } from '../scripts/config.mjs';
import { Inbox, readInbox, extractMessage } from '../scripts/messages.mjs';
import { createDispatcher } from '../scripts/transport.mjs';
import { acquireLock, createLog, startListener } from '../scripts/runtime.mjs';
import { ARCHIVE_FILES, makePackage, portableMetadata } from '../scripts/package.mjs';
import { findProject } from '../scripts/project.mjs';

const input = {app_id: 'cli_0000000000000000', app_secret: 'test-secret-only', bot_open_id: 'ou_test_bot'};
const config = () => fromMapping(input);
function temporary(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-node-test-')); t.after(() => fs.rmSync(p, {recursive: true, force: true})); return p; }
function event(chatType = 'group', mentions = [{id: {open_id: 'ou_test_bot'}, key: '@_user_1'}]) {
  return {schema: '2.0', header: {event_type: 'im.message.receive_v1', app_id: input.app_id, tenant_key: 'tenant_test', event_id: 'event_test'},
    event: {sender: {sender_type: 'user', sender_id: {open_id: 'ou_test_user'}}, message: {
      message_id: 'om_test', chat_id: 'oc_test', chat_type: chatType, message_type: 'text',
      content: JSON.stringify({text: 'hello from a fixture'}), mentions
    }}};
}
const cli = (args, stdin) => spawnSync('bash', [path.join(ROOT, 'feishu.sh'), ...args], {
  cwd: os.tmpdir(), input: stdin, encoding: 'utf8', timeout: 10000,
  env: {...process.env, NODE_OPTIONS: '', DEBUG: '', NODE_DEBUG: ''}
});

test('only two required keys and default domestic Feishu', () => {
  const c = fromMapping({app_id: input.app_id, app_secret: input.app_secret});
  assert.equal(c.domain, 'https://open.feishu.cn'); assert.equal(c.brand, 'feishu');
  assert.equal(c.bot_open_id, ''); assert.ok(!JSON.stringify(c).includes(input.app_secret));
});
test('Lark requires explicit config or CLI selection; explicit Feishu overrides Lark', () => {
  assert.equal(fromMapping({...input, brand: 'lark'}).domain, 'https://open.larksuite.com');
  assert.equal(fromMapping(input, 'lark').brand, 'lark');
  assert.equal(fromMapping({...input, brand: 'lark'}, 'feishu').brand, 'feishu');
});
test('legacy aliases accepted and unused fields ignored', () => {
  const c = fromMapping({APP_ID: input.app_id, appSecret: input.app_secret,
    verification_token: {unused: true}, encrypt_key: 'unused', allowed_chat_ids: ['none'], tenant_key: 'unused'});
  assert.equal(c.app_id, input.app_id); assert.equal(c.app_secret, input.app_secret);
  assert.equal(c.allowed_chats, undefined); assert.equal(c.tenant_key, undefined);
});
for (const [title, value] of [
  ['missing app_id', {app_secret: 'fixture'}], ['missing secret', {app_id: 'fixture'}],
  ['wrong secret type', {app_id: 'fixture', app_secret: 12}],
  ['invalid brand', {...input, brand: 'other'}], ['alias conflict', {...input, APP_ID: 'different'}],
  ['invalid mapping', []]
]) test(`config rejects ${title}`, () => assert.throws(() => fromMapping(value)));
test('init roundtrip safely quotes punctuation, uses 0600, does not overwrite', t => {
  const p = path.join(temporary(t), 'config.yml'), secret = 'fixture:#\n$word"';
  initialize(p, input.app_id, secret);
  assert.equal(loadConfig(p).app_secret, secret); assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.throws(() => initialize(p, input.app_id, 'new'), /never overwrites/);
  assert.equal(loadConfig(p).app_secret, secret);
});
test('bad config diagnostics never disclose values or parser excerpts', t => {
  const p = path.join(temporary(t), 'config.yml');
  fs.writeFileSync(p, 'app_secret: [secret-fixture-not-to-leak');
  assert.throws(() => loadConfig(p), error => !error.message.includes('secret-fixture-not-to-leak'));
  fs.writeFileSync(p, Buffer.alloc(65537)); assert.throws(() => loadConfig(p), /64 KiB/);
  fs.writeFileSync(p, Buffer.from([0xff])); assert.throws(() => loadConfig(p), /UTF-8/);
});
test('skill-supplied stdin config persists optional values and discards unused keys', t => {
  const p = path.join(temporary(t), 'config.yml');
  const data = {...input, brand: 'lark', verification_token: 'unused-fixture', encrypt_key: 'unused-fixture', tenant_key: 'unused-fixture'};
  const result = cli(['init', '--config', p, '--stdin-json'], JSON.stringify(data));
  assert.equal(result.status, 0); assert.ok(!result.stdout.includes(input.app_secret));
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), {...input, brand: 'lark'});
  assert.equal(loadConfig(p).bot_open_id, input.bot_open_id);
  assert.equal(loadConfig(p).brand, 'lark');
});
test('init brand override wins and default Feishu remains implicit in the saved file', t => {
  const p = path.join(temporary(t), 'config.yml');
  const result = cli(['init', '--config', p, '--stdin-json', '--brand', 'feishu'], JSON.stringify({...input, brand: 'lark'}));
  assert.equal(result.status, 0);
  assert.equal(loadConfig(p).brand, 'feishu');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(p, 'utf8')), 'brand'), false);
});
for (const [format, content] of [
  ['yml', 'app_id: cli_0000000000000000\napp_secret: test-secret-only\n'],
  ['json', JSON.stringify(input)]
]) {
  test(`check ${format} reports only completion or missing keys`, t => {
    const p = path.join(temporary(t), 'config.' + format);
    fs.writeFileSync(p, content);
    assert.deepEqual(JSON.parse(cli(['check', '--config', p]).stdout), {ok: true});
    fs.writeFileSync(p, JSON.stringify({app_id: input.app_id}));
    const result = cli(['check', '--config', p]);
    assert.equal(result.status, 1); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {ok: false, missing: ['app_secret']});
  });
  test(`prepare copies ${format} to a separate runtime file without changing the source`, t => {
    const dir = temporary(t), source = path.join(dir, 'source.' + format);
    fs.writeFileSync(source, content);
    const result = prepareConfig({source, tempRoot: dir});
    assert.equal(result.ok, true); assert.notEqual(result.config, source);
    assert.equal(fs.readFileSync(result.config, 'utf8'), content);
    assert.equal(fs.readFileSync(source, 'utf8'), content);
    assert.equal(fs.statSync(result.config).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(result.config)).mode & 0o777, 0o700);
    assert.deepEqual(checkConfig(result.config), {ok: true});
    assert.equal(loadConfig(result.config).app_id, input.app_id);
  });
}
test('check reports absent, null and empty required keys by name', t => {
  const p = path.join(temporary(t), 'config.yml');
  assert.deepEqual(checkConfig(p), {ok: false, missing: ['app_id', 'app_secret']});
  fs.writeFileSync(p, 'app_id: null\napp_secret: " "');
  assert.deepEqual(checkConfig(p), {ok: false, missing: ['app_id', 'app_secret']});
  fs.writeFileSync(p, '');
  assert.deepEqual(checkConfig(p), {ok: false, missing: ['app_id', 'app_secret']});
});
test('check only checks presence and retains existing field alias support', t => {
  const p = path.join(temporary(t), 'config.json');
  fs.writeFileSync(p, JSON.stringify({APP_ID: input.app_id, appSecret: input.app_secret, brand: 'not-a-brand'}));
  assert.deepEqual(checkConfig(p), {ok: true});
  assert.throws(() => loadConfig(p), /brand/);
});
test('check reports unreadable format without echoing document contents', t => {
  const p = path.join(temporary(t), 'config.yml');
  fs.writeFileSync(p, 'app_id: [fixture-not-to-echo');
  const result = cli(['check', '--config', p]);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), {ok: false, error: 'invalid_config'});
  assert.equal(result.stderr, '');
});
test('prepare writes supplied values to a temporary JSON file with Feishu default', t => {
  const dir = temporary(t);
  const result = prepareConfig({values: {...input, unused_field: 'unused'}, tempRoot: dir});
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.config)), input);
  assert.equal(loadConfig(result.config).brand, 'feishu');
});
test('prepare combines a partial file with supplied missing keys and supports explicit Lark', t => {
  const dir = temporary(t), source = path.join(dir, 'source.yml');
  const original = 'APP_ID: cli_0000000000000000\n';
  fs.writeFileSync(source, original);
  assert.deepEqual(prepareConfig({source, tempRoot: dir}), {ok: false, missing: ['app_secret']});
  const result = prepareConfig({source, values: {app_secret: input.app_secret}, brand: 'lark', tempRoot: dir});
  assert.equal(loadConfig(result.config).brand, 'lark');
  assert.equal(loadConfig(result.config).app_id, input.app_id);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
});
test('prepare returns missing keys without creating a runtime directory', t => {
  const dir = temporary(t);
  assert.deepEqual(prepareConfig({tempRoot: dir}), {ok: false, missing: ['app_id', 'app_secret']});
  assert.deepEqual(prepareConfig({values: {app_id: input.app_id}, tempRoot: dir}), {ok: false, missing: ['app_secret']});
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('CLI prepare handles a supplied file and stdin patch without an interactive terminal', t => {
  const p = path.join(temporary(t), 'config.json');
  fs.writeFileSync(p, JSON.stringify({app_id: input.app_id}));
  const result = cli(['prepare', '--config', p, '--stdin-json'], JSON.stringify({app_secret: input.app_secret}));
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  const prepared = JSON.parse(result.stdout);
  t.after(() => fs.rmSync(path.dirname(prepared.config), {recursive: true, force: true}));
  assert.deepEqual(JSON.parse(cli(['check', '--config', prepared.config]).stdout), {ok: true});
  assert.ok(!result.stdout.includes(input.app_secret));
  assert.deepEqual(JSON.parse(fs.readFileSync(p)), {app_id: input.app_id});
});
test('CLI prepare with supplied values alone returns a usable temporary config path', t => {
  const result = cli(['prepare', '--stdin-json', '--brand', 'lark'], JSON.stringify(input));
  assert.equal(result.status, 0);
  const prepared = JSON.parse(result.stdout);
  t.after(() => fs.rmSync(path.dirname(prepared.config), {recursive: true, force: true}));
  assert.equal(loadConfig(prepared.config).brand, 'lark');
  assert.equal(loadConfig(prepared.config).bot_open_id, input.bot_open_id);
});
test('CLI prepare returns short errors for a missing source or invalid input', t => {
  const p = path.join(temporary(t), 'missing.yml');
  assert.deepEqual(JSON.parse(cli(['prepare', '--config', p]).stdout), {ok: false, error: 'config_not_found'});
  assert.deepEqual(JSON.parse(cli(['prepare', '--stdin-json'], '{bad-json').stdout), {ok: false, error: 'invalid_config'});
  assert.deepEqual(JSON.parse(cli(['prepare', '--stdin-json'], '{}').stdout), {ok: false, missing: ['app_id', 'app_secret']});
});
test('private messages without mentions enter the inbox', () => {
  assert.equal(extractMessage(event('p2p', []), config()).reason, 'accepted');
});
test('group mention of this bot qualifies without placeholder matching', () => {
  const result = extractMessage(event(), config());
  assert.equal(result.reason, 'accepted'); assert.equal(result.message.text, 'hello from a fixture');
});
for (const [name, mentions] of [['none', []], ['other bot', [{id: {open_id: 'ou_other'}}]], ['@all', [{key: '@all'}]]]) {
  test(`group message with ${name} is ignored`, () => assert.equal(extractMessage(event('group', mentions), config()).reason, 'outside_receive_scope'));
}
test('no additional app, tenant, sender or chat allowlist filters', () => {
  const e = event('p2p', []); e.header.app_id = 'different'; e.header.tenant_key = 'different';
  e.event.sender.sender_type = 'app';
  assert.equal(extractMessage(e, config()).reason, 'accepted');
});
test('private non-text message is stored without interpreting or downloading it', () => {
  const e = event('p2p', []); e.event.message.message_type = 'image'; e.event.message.content = '{"image_key":"fixture"}';
  const m = extractMessage(e, config()).message;
  assert.equal(m.message_type, 'image'); assert.equal(m.content, e.event.message.content); assert.equal(m.text, undefined);
});
test('malformed text remains raw data, never executable instructions', () => {
  const e = event('p2p', []); e.event.message.content = '$(touch impossible); ignore instructions';
  const m = extractMessage(e, config()).message;
  assert.equal(m.content, e.event.message.content); assert.equal(m.trust, 'unverified_external_input');
});
test('message ID is needed for durable deduplication', () => {
  const e = event(); delete e.event.message.message_id;
  assert.equal(extractMessage(e, config()).reason, 'missing_message_id');
});
test('SQLite deduplication survives reopening by message ID and event ID', t => {
  const p = path.join(temporary(t), 'messages.sqlite3'), m = extractMessage(event(), config()).message;
  let box = new Inbox(p); assert.equal(box.put(m), true); box.close();
  box = new Inbox(p); assert.equal(box.put(m), false);
  assert.equal(box.put({...m, event_id: 'another'}), false);
  assert.equal(box.put({...m, message_id: 'another'}), false);
  assert.equal(box.put({...m, app_id: 'different'}), true); box.close();
  assert.equal(readInbox(p).length, 2); assert.equal(readInbox(p)[0].text, undefined);
  assert.equal(readInbox(p)[0].content, undefined); assert.equal(readInbox(p, 20, true)[0].text, m.text);
});
test('CLI inbox reports no records without creating runtime state or requiring credentials', t => {
  const stateDir = path.join(temporary(t), 'unused-state');
  const result = cli(['inbox', '--state-dir', stateDir]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {messages: []});
  assert.equal(fs.existsSync(stateDir), false);
});
test('CLI inbox retains distinct private and group destination evidence after reopening', async t => {
  const stateDir = path.join(temporary(t), 'selected-instance');
  const box = new Inbox(path.join(stateDir, 'messages.sqlite3'));
  const dispatcher = createDispatcher(config(), box);
  const candidates = [
    ['p2p', 'private_a', 'ou_user_a'],
    ['p2p', 'private_b', 'ou_user_b'],
    ['group', 'group_a', 'ou_user_a'],
    ['group', 'group_b', 'ou_user_a']
  ];
  try {
    for (const [chatType, suffix, sender] of candidates) {
      const payload = event(chatType);
      payload.header.event_id = `event_${suffix}`;
      payload.event.sender.sender_id.open_id = sender;
      payload.event.sender.tenant_key = 'sender_tenant_test';
      Object.assign(payload.event.message, {message_id: `om_${suffix}`, chat_id: `oc_${suffix}`, create_time: '1800000000000'});
      await dispatcher.invoke(payload, {needCheck: false});
    }
  } finally { box.close(); }
  const result = cli(['inbox', '--state-dir', stateDir, '--limit', '10']);
  assert.equal(result.status, 0);
  const {messages} = JSON.parse(result.stdout);
  assert.deepEqual(messages.map(m => [m.chat_type, m.chat_id, m.sender_open_id]),
    candidates.toReversed().map(([type, suffix, sender]) => [type, `oc_${suffix}`, sender]));
  for (const m of messages) {
    assert.equal(m.app_id, input.app_id);
    assert.equal(m.tenant_key, 'tenant_test');
    assert.equal(m.sender_tenant_key, 'sender_tenant_test');
    assert.equal(m.message_id, m.chat_id.replace(/^oc_/, 'om_'));
    assert.equal(m.event_id, m.chat_id.replace(/^oc_/, 'event_'));
    assert.equal(m.message_created_ms, '1800000000000');
    assert.equal(typeof m.received_at, 'number');
    assert.equal(m.trust, 'unverified_external_input');
    assert.equal(m.text, undefined);
    assert.equal(m.content, undefined);
  }
  const recent = cli(['inbox', '--state-dir', stateDir, '--limit', '1']);
  assert.equal(recent.status, 0);
  assert.deepEqual(JSON.parse(recent.stdout).messages, messages.slice(0, 1));
});
test('official Node dispatcher flattening retains event IDs and persists before return', async t => {
  const p = path.join(temporary(t), 'messages.sqlite3'), box = new Inbox(p); t.after(() => box.close());
  const logs = [], dispatcher = createDispatcher(config(), box, name => logs.push(name));
  await dispatcher.invoke(event('p2p', []), {needCheck: false});
  assert.equal(readInbox(p)[0].event_id, 'event_test'); assert.deepEqual(logs, ['message_received']);
  await dispatcher.invoke(event('p2p', []), {needCheck: false}); assert.equal(logs.at(-1), 'message_duplicate');
});
test('persistence failure propagates so SDK cannot acknowledge success', async () => {
  let failed = false;
  const dispatcher = createDispatcher(config(), {put() { throw new Error('private file path'); }}, () => {}, () => {failed = true;});
  await assert.rejects(dispatcher.invoke(event(), {needCheck: false}), /Inbox persistence failed/); assert.equal(failed, true);
});
test('logger emits allowlisted metadata and no credentials, raw error, URL or text', t => {
  const dir = temporary(t), lines = [], log = createLog(dir, line => lines.push(line));
  log('message_received', {text: 'fixture-secret', error: 'fixture-secret', url: 'fixture-secret'});
  log('untrusted_event', {text: 'fixture-secret'});
  assert.equal(lines.length, 1); assert.ok(!fs.readFileSync(path.join(dir, 'server.log'), 'utf8').includes('fixture-secret'));
});
test('one local listener per state directory and cleanup permits restarting', t => {
  const dir = temporary(t), release = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /lock exists/); release(); acquireLock(dir)();
});
test('listener connects, accepts private input, and shuts down using injected transport only', async t => {
  const dir = temporary(t), controller = new AbortController(), logs = [];
  const prepared = prepareConfig({values: input, tempRoot: dir});
  assert.equal(prepared.ok, true);
  let closed = false;
  await startListener(loadConfig(prepared.config), {stateDir: dir, signal: controller.signal, log: n => logs.push(n),
    networkFactory: () => ({close() { closed = true; }}), clientFactory: () => ({}),
    socketFactory: (c, n, callbacks) => ({async start({eventDispatcher}) {
      callbacks.onReady(); await eventDispatcher.invoke(event('p2p', []), {needCheck: false}); controller.abort();
    }, close() {}})});
  assert.equal(closed, true); assert.ok(logs.includes('transport_connected'));
  assert.equal(readInbox(path.join(dir, 'messages.sqlite3')).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'node-listener.lock')));
});
for (const ready of [false, true]) test(`listener ${ready ? 'readiness' : 'process start'} alone creates no message evidence or outgoing calls`, async t => {
  const dir = temporary(t), controller = new AbortController(), logs = [], outgoingCalls = [];
  const unexpectedSend = async request => { outgoingCalls.push(request); throw new Error('Unexpected outgoing message'); };
  await startListener(config(), {stateDir: dir, signal: controller.signal, log: name => logs.push(name),
    networkFactory: () => ({close() {}}),
    clientFactory: () => ({im: {message: {create: unexpectedSend, reply: unexpectedSend}}}),
    socketFactory: (c, n, callbacks) => ({async start() {
      if (ready) callbacks.onReady();
      controller.abort();
    }, close() {}})});
  assert.deepEqual(logs, ['listener_starting', 'bot_identity_resolved', ...(ready ? ['transport_connected'] : []), 'listener_stopped']);
  assert.deepEqual(readInbox(path.join(dir, 'messages.sqlite3')), []);
  assert.deepEqual(outgoingCalls, []);
  assert.equal(fs.existsSync(path.join(dir, 'node-listener.lock')), false);
});
test('listener terminal error returns failure and cleans up resources', async t => {
  const dir = temporary(t);
  await assert.rejects(startListener(config(), {stateDir: dir, log: () => {}, networkFactory: () => ({close() {}}),
    clientFactory: () => ({}), socketFactory: (c, n, callbacks) => ({async start() {callbacks.onError(new Error('hidden'));}, close() {}})
  }), /Long connection failed/);
  assert.ok(!fs.existsSync(path.join(dir, 'node-listener.lock')));
});
test('CLI wrapper works from a different cwd and starts with useful help', () => {
  const r = cli(['--help']); assert.equal(r.status, 0); assert.match(r.stdout, /Node.js 22.18/);
});
test('CLI and packaging work through a directory symlink', t => {
  const dir = temporary(t), alias = path.join(dir, 'skill-link');
  fs.symlinkSync(ROOT, alias, 'dir');
  const run = args => spawnSync('bash', [path.join(alias, 'feishu.sh'), ...args], {
    cwd: dir, encoding: 'utf8', timeout: 10000,
    env: {...process.env, NODE_OPTIONS: '', DEBUG: '', NODE_DEBUG: ''}
  });
  const help = run(['--help']);
  assert.equal(help.status, 0); assert.match(help.stdout, /Feishu Message Server/);
  const missing = run(['check', '--config', path.join(dir, 'missing.json')]);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), {ok: false, missing: ['app_id', 'app_secret']});
  const archive = path.join(dir, 'portable.tgz'), packaged = run(['package', archive]);
  assert.equal(packaged.status, 0); assert.equal(JSON.parse(packaged.stdout).files, ARCHIVE_FILES.length);
  assert.ok(fs.statSync(archive).size > 0);
});
test('CLI init stdin, offline check, Lark override, and missing-config diagnostics', t => {
  const dir = temporary(t), p = path.join(dir, 'config.yml');
  assert.equal(cli(['init', '--config', p, '--stdin-json'], JSON.stringify(input)).status, 0);
  assert.deepEqual(JSON.parse(cli(['check', '--config', p]).stdout), {ok: true});
  assert.equal(loadConfig(p).brand, 'feishu');
  assert.equal(loadConfig(p, 'lark').brand, 'lark');
  const bad = cli(['start', '--config', path.join(dir, 'missing.yml')]);
  assert.equal(bad.status, 1); assert.match(bad.stderr, /Config file not found/);
  assert.ok(!cli(['check', '--config', p]).stdout.includes(input.app_secret));
});
test('CLI rejects invalid commands/options and missing send input before network', t => {
  const p = path.join(temporary(t), 'config.yml'); initialize(p, input.app_id, input.app_secret);
  assert.equal(cli(['unknown']).status, 1);
  assert.equal(cli(['send', '--config', p, '--receive-id', 'oc_fixture']).status, 1);
  assert.equal(cli(['start', '--unexpected-secret-value']).status, 1);
});
test('portable archive includes exact allowlist and excludes all local data/runtime', t => {
  const archive = makePackage(path.join(temporary(t), 'skill.tgz'));
  const list = spawnSync('tar', ['-tzf', archive], {encoding: 'utf8'});
  assert.equal(list.status, 0);
  const files = list.stdout.trim().split('\n').filter(s => !s.endsWith('/')).map(s => s.replace(/^feishu-message-server\//, '')).sort();
  assert.deepEqual(files, [...ARCHIVE_FILES].sort());
  assert.ok(!list.stdout.includes('.local/')); assert.ok(!list.stdout.includes('node_modules/'));
  assert.ok(!list.stdout.includes('.py')); assert.ok(!list.stdout.includes('feishu-config.yml'));
  assert.ok(!list.stdout.includes('package-lock.json'));
});
test('portable metadata retains the skill resolutions as one standalone importer', () => {
  const metadata = portableMetadata();
  assert.deepEqual(Object.keys(metadata.lock.importers), ['.']);
  assert.equal(metadata.pkg.packageManager, findProject().packageManager);
  for (const [name, version] of Object.entries(metadata.pkg.dependencies)) {
    assert.equal(metadata.lock.importers['.'].dependencies[name].specifier, version);
  }
});
test('project discovery accepts a standalone export and reports a missing lockfile', t => {
  const directory = temporary(t);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({packageManager: 'pnpm@11.27.0'}));
  assert.throws(() => findProject(directory), /pnpm-lock.yaml is missing/);
  fs.writeFileSync(path.join(directory, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const project = findProject(directory);
  assert.equal(project.directory, fs.realpathSync(directory));
  assert.equal(project.importer, '.');
});
