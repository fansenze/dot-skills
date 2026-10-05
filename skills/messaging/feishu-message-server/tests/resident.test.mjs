import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execFile, spawn, spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {promisify} from 'node:util';
import {startResident, residentRequest, runtimeIdentity} from '../scripts/resident.mjs';
import {findProject} from '../scripts/project.mjs';

const IDENTITY = () => ({app_id: 'cli_resident_fixture_only', brand: 'feishu', runtime: runtimeIdentity()});
const FIXTURE = fileURLToPath(new URL('./fixtures/resident-process.mjs', import.meta.url));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = new WeakMap();
function onCleanup(t, cleanup) {
  if (!cleanups.has(t)) {
    const stack = []; cleanups.set(t, stack);
    t.after(async () => { for (const action of stack.reverse()) await action(); });
  }
  cleanups.get(t).push(cleanup);
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resident-fixture-'));
  fs.chmodSync(directory, 0o700);
  onCleanup(t, () => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
function cleanEnvironment(extra = {}) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/proxy$/i.test(key)) delete env[key];
  return {...env, ...extra};
}
function processFixture(t, mode, directory, provider = 'http://127.0.0.1:1', operation = 'health', args = {}, env = {}) {
  const began = performance.now();
  const child = spawn(process.execPath, [FIXTURE, mode, directory, provider, operation, JSON.stringify(args)], {
    env: cleanEnvironment(env), stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => {stdout += data;}); child.stderr.on('data', data => {stderr += data;});
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal, stdout, stderr, wall_ms: performance.now() - began,
      messages: stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))}));
  });
  onCleanup(t, async () => {if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL'); await done;}});
  return {child, done, output: () => stdout};
}
async function waitUntil(check, description) {
  const deadline = performance.now() + 8000;
  while (!check()) {
    assert.ok(performance.now() < deadline, `Timed out: ${description}`);
    await delay(10);
  }
}
async function residentProcess(t, directory, provider, options = {}) {
  const result = processFixture(t, 'resident', directory, provider, 'health', options);
  await waitUntil(() => result.output().includes('"ready":true') || result.child.exitCode !== null, 'synthetic resident readiness');
  assert.equal(result.child.exitCode, null, result.output());
  return result;
}
async function requestProcess(t, directory, operation, args = {}, env = {}) {
  return processFixture(t, 'request', directory, undefined, operation, args, env).done;
}
async function providerFixture(t, {authDelay = 0, messageDelay = 0, hangKeys = []} = {}) {
  const calls = [], held = new Set();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const data = body ? JSON.parse(body) : {};
    const call = {url: req.url, method: req.method, data, authorization: req.headers.authorization, socket: req.socket.remotePort};
    calls.push(call);
    const auth = req.url === '/open-apis/auth/v3/tenant_access_token/internal';
    if (auth) {
      assert.equal(data.app_id, 'cli_resident_fixture_only');
      assert.equal(data.app_secret, 'synthetic-not-a-real-service-secret');
      await delay(authDelay);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({code: 0, tenant_access_token: 'synthetic_provider_token_only', expire: 7200}));
    } else {
      assert.match(req.url, /^\/open-apis\/im\/v1\/messages(?:\/om_fixture_parent\/reply)?(?:\?|$)/);
      assert.equal(req.headers.authorization, 'Bearer synthetic_provider_token_only');
      if (hangKeys.includes(data.uuid)) {held.add(res); res.once('close', () => held.delete(res)); return;}
      await delay(messageDelay);
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({code: 0, data: {message_id: `om_fixture_${data.uuid}`}}));
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  onCleanup(t, () => new Promise(resolve => {for (const response of held) response.destroy(); server.closeAllConnections(); server.close(resolve);}));
  return {url: `http://127.0.0.1:${server.address().port}`, calls,
    authCalls: () => calls.filter(v => v.url.includes('/auth/')), messageCalls: () => calls.filter(v => !v.url.includes('/auth/'))};
}
async function raw(directory, body, options = {}) {
  const endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json'), 'utf8'));
  const data = options.rawBody ?? JSON.stringify({identity: endpoint.identity, instance: endpoint.instance, operation: 'health', args: {}, ...body});
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: endpoint.port, method: options.method ?? 'POST', path: options.path ?? '/v1',
      headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...options.headers}}, res => {
      let response = ''; res.on('data', chunk => {response += chunk;});
      res.on('end', () => resolve({status: res.statusCode, data: JSON.parse(response)}));
    });
    req.on('error', reject);
    if (options.splitAt) { const bytes = Buffer.from(data); req.write(bytes.subarray(0, options.splitAt)); setTimeout(() => req.end(bytes.subarray(options.splitAt)), 30); }
    else req.end(data);
  });
}
async function localResident(t, directory, handler = async () => ({ok: true})) {
  const resident = await startResident({directory, identity: IDENTITY(), handler});
  onCleanup(t, () => resident.close());
  return resident;
}
const sendArgs = key => ({receiveId: 'oc_synthetic_fixture', text: 'Synthetic loopback message', idempotencyKey: key});

test('resident creates its directory and accepts local clients without provisioning an access token', async t => {
  const directory = path.join(temporary(t), 'state', 'resident');
  await localResident(t, directory);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['endpoint.json', 'receipts', 'resident.lock']);
  assert.deepEqual(await residentRequest({directory, identity: IDENTITY(), operation: 'health'}), {ok: true});
  assert.deepEqual(await raw(directory, {}), {status: 200, data: {ok: true}});
});

test('CLI reuses a resident for health, send and reply with only the selected config and state', async t => {
  const root = temporary(t), stateDir = path.join(root, 'state'), directory = path.join(stateDir, 'resident');
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({app_id: IDENTITY().app_id, app_secret: 'synthetic-cli-secret-only'}), {mode: 0o600});
  const dispatched = [];
  await localResident(t, directory, async (operation, args) => {
    dispatched.push({operation, args});
    return operation === 'health' ? {ok: true, receiver_connected: true, state_dir: stateDir, identity: IDENTITY()}
      : {ok: true, message_id: 'om_cli_fixture'};
  });
  const cli = promisify(execFile), server = fileURLToPath(new URL('../scripts/server.mjs', import.meta.url));
  for (const [command, args] of [
    ['start', []], ['health', []],
    ['send', ['--receive-id', 'oc_synthetic_fixture', '--text', 'Synthetic CLI message', '--idempotency-key', 'cli_send']],
    ['reply', ['--message-id', 'om_cli_fixture', '--text', 'Synthetic CLI reply', '--idempotency-key', 'cli_reply']]
  ]) {
    const {stdout} = await cli(process.execPath, ['--disable-warning=ExperimentalWarning', server, command,
      '--config', configFile, '--state-dir', stateDir, ...args], {env: cleanEnvironment(), timeout: 10000});
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    if (command === 'start') assert.equal(result.reused, true);
  }
  assert.deepEqual(dispatched.map(value => value.operation), ['health', 'health', 'send', 'reply']);
  assert.equal(dispatched[2].args.body, 'Synthetic CLI message');
  assert.equal(dispatched[3].args.messageId, 'om_cli_fixture');
});

test('resident refuses a directory readable by other users before publishing an endpoint', async t => {
  const directory = temporary(t); fs.chmodSync(directory, 0o755);
  await assert.rejects(localResident(t, directory), /unsafe-local-permissions/);
  assert.equal(fs.existsSync(path.join(directory, 'endpoint.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
});

test('actual loopback resident validates request shape, identity, runtime, instance, JSON and fixed operation allowlist', async t => {
  const directory = temporary(t); let dispatched = 0;
  await localResident(t, directory, async () => {dispatched++; return {ok: true};});
  for (const options of [
    {headers: {origin: 'https://attacker.invalid'}},
    {headers: {'content-type': 'text/plain'}}, {method: 'GET'}, {path: '/arbitrary'}
  ]) assert.equal((await raw(directory, {}, options)).status, 403);
  for (const body of [
    {identity: {...IDENTITY(), app_id: 'cli_wrong_app'}}, {identity: {...IDENTITY(), brand: 'lark'}},
    {identity: {...IDENTITY(), runtime: 'wrong-runtime'}}, {instance: 'stale-instance'},
    {operation: 'eval'}, {operation: 'start'}, {operation: 'shell'}, {args: []}, {args: null}
  ]) assert.equal((await raw(directory, body)).status, 400);
  assert.equal((await raw(directory, {}, {rawBody: '{bad JSON'})).status, 400);
  assert.equal(dispatched, 0);
  assert.deepEqual((await raw(directory, {})).data, {ok: true});
  assert.equal(dispatched, 1);
});

test('client refuses wrong account/runtime and insecure endpoint metadata before any dispatch', async t => {
  const directory = temporary(t); let dispatched = 0;
  await localResident(t, directory, async () => {dispatched++; return {ok: true};});
  for (const identity of [{...IDENTITY(), app_id: 'wrong'}, {...IDENTITY(), brand: 'lark'}, {...IDENTITY(), runtime: 'other'}]) {
    await assert.rejects(residentRequest({directory, identity, operation: 'health'}), /resident-binding-mismatch/);
  }
  const endpointFile = path.join(directory, 'endpoint.json');
  fs.chmodSync(endpointFile, 0o644);
  await assert.rejects(residentRequest({directory, identity: IDENTITY(), operation: 'health'}), /resident-unavailable-no-fallback/);
  fs.chmodSync(endpointFile, 0o600);
  assert.equal(dispatched, 0);
});

test('separate processes reuse one resident SDK/client, bypass hostile local proxy, and report synthetic cold/warm latency', async t => {
  const directory = temporary(t), provider = await providerFixture(t, {authDelay: 120, messageDelay: 15});
  const resident = await residentProcess(t, directory, provider.url);
  const cold = [], warm = [];
  for (let index = 0; index < 3; index++) {
    const result = await processFixture(t, 'direct', directory, provider.url, 'send', sendArgs(`cold_${index}`)).done;
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(result.messages[0].result.ok, true);
    cold.push(result);
  }
  assert.equal(provider.authCalls().length, 3);
  const first = await requestProcess(t, directory, 'send', sendArgs('resident_first'));
  assert.equal(first.code, 0, first.stdout + first.stderr); assert.equal(first.messages[0].result.ok, true);
  assert.equal(provider.authCalls().length, 4);
  for (let index = 0; index < 3; index++) {
    const result = await requestProcess(t, directory, 'send', sendArgs(`warm_${index}`), {
      HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1',
      http_proxy: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1', NO_PROXY: '', no_proxy: ''
    });
    assert.equal(result.code, 0, result.stdout + result.stderr); assert.equal(result.messages[0].result.ok, true);
    warm.push(result);
  }
  assert.equal(provider.authCalls().length, 4, 'three direct processes authenticate three times; the resident authenticates only once');
  assert.equal(provider.messageCalls().length, 7);
  const residentCalls = provider.calls.slice(6);
  assert.equal(new Set(residentCalls.map(call => call.socket)).size, 1, 'resident authentication and warm sends reuse one provider socket');
  const average = entries => Math.round(entries.reduce((sum, value) => sum + value, 0) / entries.length);
  t.diagnostic(JSON.stringify({synthetic_loopback_only: true, authentication_delay_ms: 120,
    direct_cold_request_ms: cold.map(v => Math.round(v.messages[0].elapsed_ms)), direct_cold_process_ms: cold.map(v => Math.round(v.wall_ms)),
    resident_first_request_ms: Math.round(first.messages[0].elapsed_ms), resident_warm_request_ms: warm.map(v => Math.round(v.messages[0].elapsed_ms)),
    resident_warm_process_ms: warm.map(v => Math.round(v.wall_ms)),
    cold_average_ms: average(cold.map(v => v.messages[0].elapsed_ms)), warm_average_ms: average(warm.map(v => v.messages[0].elapsed_ms)), provider_auth_calls: provider.authCalls().length, resident_provider_sockets: new Set(residentCalls.map(call => call.socket)).size}));
  resident.child.kill('SIGTERM'); assert.equal((await resident.done).code, 0);
  assert.equal(fs.existsSync(path.join(directory, 'endpoint.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
});

test('concurrent separate clients deduplicate identical send/reply keys and reject content conflicts', async t => {
  const directory = temporary(t), provider = await providerFixture(t, {messageDelay: 200});
  await residentProcess(t, directory, provider.url);
  const results = await Promise.all(Array.from({length: 6}, () => requestProcess(t, directory, 'send', sendArgs('concurrent_same'))));
  assert.ok(results.every(v => v.code === 0 && v.messages[0].result.ok), JSON.stringify(results));
  assert.equal(provider.messageCalls().length, 1);
  assert.ok(results.every(v => v.messages[0].result.message_id === 'om_fixture_concurrent_same'));
  const conflict = await requestProcess(t, directory, 'send', {...sendArgs('concurrent_same'), text: 'Changed synthetic content'});
  assert.equal(conflict.code, 1); assert.match(conflict.messages[0].error, /idempotency-conflict/);
  const pending = requestProcess(t, directory, 'reply', {messageId: 'om_fixture_parent', text: 'Synthetic reply', idempotencyKey: 'reply_same'});
  await waitUntil(() => provider.messageCalls().length === 2, 'reply provider request');
  const replyConflict = await requestProcess(t, directory, 'reply', {messageId: 'om_fixture_parent', text: 'Changed reply', idempotencyKey: 'reply_same'});
  assert.equal(replyConflict.code, 1); assert.match(replyConflict.messages[0].error, /idempotency-conflict/);
  assert.equal((await pending).messages[0].result.ok, true);
  assert.equal(provider.messageCalls().length, 2);
  for (const key of [undefined, '', '../escape', 'x'.repeat(51)]) {
    const value = await requestProcess(t, directory, 'send', {...sendArgs('invalid'), idempotencyKey: key});
    assert.equal(value.code, 1); assert.match(value.messages[0].error, /idempotency-key-required/);
  }
  assert.equal(provider.messageCalls().length, 2);
});

test('an interrupted provider attempt remains durably unknown after crash and explicit dead-fixture lock cleanup', async t => {
  const directory = temporary(t), provider = await providerFixture(t, {hangKeys: ['crash_unknown']});
  const resident = await residentProcess(t, directory, provider.url);
  const pending = requestProcess(t, directory, 'send', sendArgs('crash_unknown'));
  await waitUntil(() => provider.messageCalls().length === 1, 'durable attempt reached synthetic provider');
  resident.child.kill('SIGKILL'); assert.equal((await resident.done).signal, 'SIGKILL');
  const interrupted = await pending;
  assert.equal(interrupted.code, 1); assert.match(interrupted.messages[0].error, /resident-delivery-unknown-no-fallback/);
  const blocked = await processFixture(t, 'resident', directory, provider.url).done;
  assert.equal(blocked.code, 1); assert.match(blocked.messages[0].error, /resident-lock-exists-no-fallback/);
  // Only the test's known dead child lock is removed. Production does not silently recover or fall back.
  fs.rmSync(path.join(directory, 'resident.lock'), {recursive: true});
  const restarted = await residentProcess(t, directory, provider.url);
  const repeated = await requestProcess(t, directory, 'send', sendArgs('crash_unknown'));
  assert.equal(repeated.code, 0); assert.deepEqual(repeated.messages[0].result, {
    ok: false, status: 'delivery_unknown', idempotency_key: 'crash_unknown', error_code: 'resident-interrupted-no-retry'
  });
  assert.equal(provider.messageCalls().length, 1); assert.equal(provider.authCalls().length, 1);
  restarted.child.kill('SIGTERM'); assert.equal((await restarted.done).code, 0);
});

test('resident lock rejects a duplicate process without replacing the healthy endpoint', async t => {
  const directory = temporary(t), provider = await providerFixture(t);
  await residentProcess(t, directory, provider.url);
  const before = fs.readFileSync(path.join(directory, 'endpoint.json'), 'utf8');
  const duplicate = await processFixture(t, 'resident', directory, provider.url).done;
  assert.equal(duplicate.code, 1); assert.match(duplicate.messages[0].error, /resident-lock-exists-no-fallback/);
  assert.equal(fs.readFileSync(path.join(directory, 'endpoint.json'), 'utf8'), before);
  assert.equal((await requestProcess(t, directory, 'health')).messages[0].result.status, 'ready');
  assert.equal(provider.calls.length, 0);
});

test('stale endpoint and stale instance fail closed with no fallback or provider call', async t => {
  const directory = temporary(t), provider = await providerFixture(t);
  const resident = await residentProcess(t, directory, provider.url);
  const filename = path.join(directory, 'endpoint.json'), saved = fs.readFileSync(filename, 'utf8');
  const changed = JSON.parse(saved); changed.instance = 'stale-instance'; fs.writeFileSync(filename, JSON.stringify(changed));
  const mismatch = await requestProcess(t, directory, 'send', sendArgs('stale_instance'));
  assert.equal(mismatch.code, 1); assert.match(mismatch.messages[0].error, /resident-binding-or-operation-mismatch/);
  fs.writeFileSync(filename, saved);
  resident.child.kill('SIGTERM'); assert.equal((await resident.done).code, 0);
  fs.writeFileSync(filename, saved, {mode: 0o600});
  const missing = await requestProcess(t, directory, 'send', sendArgs('stale_port'));
  assert.equal(missing.code, 1); assert.match(missing.messages[0].error, /resident-delivery-unknown-no-fallback/);
  assert.equal(provider.calls.length, 0);
});

for (const signal of ['SIGTERM', 'SIGINT']) test(`${signal} removes endpoint and owned lock and allows a fresh resident`, async t => {
  const directory = temporary(t), provider = await providerFixture(t);
  const resident = await residentProcess(t, directory, provider.url);
  resident.child.kill(signal); assert.equal((await resident.done).code, 0);
  assert.equal(fs.existsSync(path.join(directory, 'endpoint.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
  const restarted = await residentProcess(t, directory, provider.url);
  assert.equal((await requestProcess(t, directory, 'identity')).messages[0].result.identity.app_id, IDENTITY().app_id);
  restarted.child.kill('SIGTERM'); assert.equal((await restarted.done).code, 0);
});

test('unsafe receipts directory is rejected before acquiring the resident lock', async t => {
  const directory = temporary(t);
  const receipts = path.join(directory, 'receipts');
  fs.mkdirSync(receipts, {mode: 0o755});
  // The wrapper sets umask 077; chmod makes the unsafe fixture explicit.
  fs.chmodSync(receipts, 0o755);
  // Register cleanup even if a regression unexpectedly accepts the directory.
  await assert.rejects(localResident(t, directory), /unsafe-local-permissions/);
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
  assert.equal(fs.existsSync(path.join(directory, 'endpoint.json')), false);
});

test('oversized requests are rejected without dispatch', async t => {
  const directory = temporary(t); let dispatched = 0;
  await localResident(t, directory, async () => {dispatched++; return {ok: true};});
  const oversized = await raw(directory, {args: {text: 'x'.repeat(100001)}});
  assert.equal(oversized.status, 400); assert.equal(oversized.data.error, 'request-too-large');
  assert.equal(dispatched, 0);
  assert.equal((await raw(directory, {})).status, 200);
});

test('read-only child operations need no provider authentication and completed sends survive restart', async t => {
  const directory = temporary(t), provider = await providerFixture(t);
  const resident = await residentProcess(t, directory, provider.url);
  for (const operation of ['health', 'identity', 'capabilities', 'inbox', 'inbox-page']) {
    const response = await requestProcess(t, directory, operation, {});
    assert.equal(response.code, 0, response.stdout + response.stderr); assert.equal(response.messages[0].result.ok, true);
  }
  assert.equal(provider.calls.length, 0);
  const first = await requestProcess(t, directory, 'send', sendArgs('durable_success'));
  resident.child.kill('SIGTERM'); assert.equal((await resident.done).code, 0);
  const restarted = await residentProcess(t, directory, provider.url);
  const replay = await requestProcess(t, directory, 'send', sendArgs('durable_success'));
  assert.deepEqual(replay.messages[0].result, first.messages[0].result);
  assert.equal(provider.messageCalls().length, 1); assert.equal(provider.authCalls().length, 1);
  restarted.child.kill('SIGTERM'); assert.equal((await restarted.done).code, 0);
});

test('an impatient local client receives unknown while the durable provider result is later replayed', async t => {
  const directory = temporary(t); let sends = 0;
  await localResident(t, directory, async () => {sends++; await delay(120); return {ok: true, message_id: 'om_delayed'};});
  const input = {directory, identity: IDENTITY(), operation: 'send', args: sendArgs('impatient')};
  await assert.rejects(residentRequest({...input, timeout: 20}), /resident-delivery-unknown-no-fallback/);
  const replay = await residentRequest(input);
  assert.deepEqual(replay, {ok: true, message_id: 'om_delayed'});
  assert.equal(sends, 1);
});

test('handler exceptions are sanitized, durable, and never automatically resent', async t => {
  const directory = temporary(t); let sends = 0;
  const resident = await localResident(t, directory, async () => {sends++; throw new Error('private fixture failure must not escape');});
  const input = {directory, identity: IDENTITY(), operation: 'reply', args: {messageId: 'om_fixture_parent', text: 'Synthetic reply', idempotencyKey: 'handler_unknown'}};
  const first = await residentRequest(input); assert.equal(first.status, 'delivery_unknown');
  assert.equal(first.error_code, 'resident-handler-unknown'); assert.ok(!JSON.stringify(first).includes('private'));
  await resident.close();
  await localResident(t, directory, async () => {sends++; return {ok: true};});
  assert.deepEqual(await residentRequest(input), first); assert.equal(sends, 1);
});

test('endpoint publication failure releases its owned lock and preserves the existing path', async t => {
  const directory = temporary(t);
  fs.mkdirSync(path.join(directory, 'endpoint.json'), {mode: 0o700});
  await assert.rejects(startResident({directory, identity: IDENTITY(), handler: async () => ({ok: true})}));
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
  assert.equal(fs.lstatSync(path.join(directory, 'endpoint.json')).isDirectory(), true);
});

test('corrupt endpoint metadata cannot prevent shutdown from releasing its owned lock', async t => {
  const directory = temporary(t);
  const resident = await startResident({directory, identity: IDENTITY(), handler: async () => ({ok: true})});
  fs.writeFileSync(path.join(directory, 'endpoint.json'), '{malformed');
  await resident.close().catch(() => {});
  assert.equal(fs.existsSync(path.join(directory, 'resident.lock')), false);
});


test('parallel cold distinct-key clients share one provider authentication flight', async t => {
  const directory = temporary(t), provider = await providerFixture(t, {authDelay: 200, messageDelay: 20});
  await residentProcess(t, directory, provider.url);
  const responses = await Promise.all(Array.from({length: 6}, (_, index) => requestProcess(t, directory, 'send', sendArgs(`cold_parallel_${index}`))));
  assert.ok(responses.every(response => response.code === 0 && response.messages[0].result.ok), JSON.stringify(responses));
  assert.equal(provider.messageCalls().length, 6);
  assert.equal(provider.authCalls().length, 1, 'simultaneous distinct first sends share the same pending authentication');
});

test('synthetic SDK receive is durably paged and explicitly replied to through separate resident clients', async t => {
  const directory = temporary(t), provider = await providerFixture(t);
  await residentProcess(t, directory, provider.url, {seedReceive: true});
  assert.equal(provider.calls.length, 0, 'receiving and duplicate delivery never auto-reply or authenticate');
  const response = await requestProcess(t, directory, 'inbox-page', {showText: true, limit: 10});
  assert.equal(response.code, 0, response.stdout + response.stderr);
  const page = response.messages[0].result;
  assert.equal(page.messages.length, 1, 'SDK-dispatched duplicate event is stored once');
  const message = page.messages[0].message;
  assert.equal(message.message_id, 'om_fixture_parent'); assert.equal(message.chat_id, 'oc_synthetic_fixture');
  assert.equal(message.text, 'Synthetic received message'); assert.equal(message.trust, 'unverified_external_input');
  assert.equal(message.sender_open_id, 'ou_synthetic_sender');
  const next = await requestProcess(t, directory, 'inbox-page', {cursor: page.next_cursor, showText: true});
  assert.equal(next.messages[0].result.messages.length, 0); assert.equal(provider.calls.length, 0);
  const reply = await requestProcess(t, directory, 'reply', {messageId: message.message_id, text: 'Explicit synthetic reply',
    replyInThread: true, idempotencyKey: 'received_reply'});
  assert.equal(reply.messages[0].result.ok, true); assert.equal(provider.messageCalls().length, 1);
  assert.equal(provider.messageCalls()[0].url, '/open-apis/im/v1/messages/om_fixture_parent/reply');
  assert.equal(provider.messageCalls()[0].data.reply_in_thread, true);
  assert.equal(JSON.parse(provider.messageCalls()[0].data.content).text, 'Explicit synthetic reply');
});

test('runtime identity works in a relocated directory containing spaces and non-ASCII characters', t => {
  const directory = temporary(t), relocated = path.join(directory, 'space fixture ü');
  const root = fileURLToPath(new URL('..', import.meta.url));
  fs.mkdirSync(relocated);
  fs.cpSync(path.join(root, 'scripts'), path.join(relocated, 'scripts'), {recursive: true});
  fs.copyFileSync(path.join(root, 'package.json'), path.join(relocated, 'package.json'));
  fs.copyFileSync(findProject().lockfile, path.join(relocated, 'pnpm-lock.yaml'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(relocated, 'node_modules'), 'dir');
  const source = `import {runtimeIdentity} from ${JSON.stringify(pathToFileURL(path.join(relocated, 'scripts/resident.mjs')).href)}; console.log(runtimeIdentity());`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {encoding: 'utf8', env: cleanEnvironment()});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), runtimeIdentity());
});


test('split UTF-8 request bytes retain exact text and malformed UTF-8 is rejected', async t => {
  const directory = temporary(t); let dispatched = 0;
  await localResident(t, directory, async (_operation, args) => {dispatched++; return {ok: true, text: args.text};});
  const endpoint = JSON.parse(fs.readFileSync(path.join(directory, 'endpoint.json'), 'utf8'));
  const body = JSON.stringify({identity: endpoint.identity, instance: endpoint.instance, operation: 'health', args: {text: '你好，fixture 🌍'}});
  const split = await raw(directory, {}, {rawBody: body, splitAt: Buffer.from(body).indexOf(Buffer.from('你')) + 1});
  assert.equal(split.status, 200); assert.equal(split.data.text, '你好，fixture 🌍');
  const malformed = Buffer.concat([Buffer.from(body.slice(0, body.indexOf('你'))), Buffer.from([0xff]), Buffer.from(body.slice(body.indexOf('你') + 1))]);
  const rejected = await raw(directory, {}, {rawBody: malformed});
  assert.equal(rejected.status, 400); assert.equal(dispatched, 1);
});
