import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { fromMapping } from '../scripts/config.mjs';
import { createNetwork, createClient, createSocket, resolveBotIdentity, sendText, outgoingContent, getHttpDiagnostics } from '../scripts/transport.mjs';

const input = {app_id: 'cli_0000000000000000', app_secret: 'test-secret-only'};
const config = () => fromMapping(input);
function proxyEnvironment(t) {
  const saved = {};
  for (const key of Object.keys(process.env).filter(k => /proxy$/i.test(k))) {
    saved[key] = process.env[key]; delete process.env[key];
  }
  t.after(() => {
    for (const key of Object.keys(process.env).filter(k => /proxy$/i.test(k))) delete process.env[key];
    Object.assign(process.env, saved);
  });
}

function httpFixture(t, name, respond) {
  const network = createNetwork(); t.after(() => network.close());
  const calls = [];
  network.httpInstance.defaults.adapter = async request => {
    calls.push(request);
    const data = await respond(request);
    return {data, status: 200, statusText: 'OK', headers: {}, config: request};
  };
  // A distinct synthetic app isolates the SDK's token cache between cases.
  const client = createClient(fromMapping({...input, app_id: `fixture-${name}`}), network);
  return {network, client, calls};
}
const tokenResponse = {code: 0, tenant_access_token: 'fixture-token', expire: 7200};
const isAuthentication = request => request.url.endsWith('/auth/v3/tenant_access_token/internal');

test('bot identity comes from authenticated bot.open_id response shape', async () => {
  let payload;
  const c = await resolveBotIdentity(config(), {request: async p => {payload = p; return {code: 0, bot: {open_id: 'ou_fixture'}};}});
  assert.equal(c.bot_open_id, 'ou_fixture'); assert.equal(payload.url, '/open-apis/bot/v3/info');
});
test('configured bot identity skips lookup', async () => {
  const c = fromMapping({...input, bot_open_id: 'ou_fixture'});
  await resolveBotIdentity(c, {request() { throw new Error('unexpected request'); }});
});
test('wrong bot response and authentication errors produce sanitized diagnostics', async () => {
  await assert.rejects(resolveBotIdentity(config(), {request: async () => ({code: 0, data: {open_id: 'wrong_shape'}})}), /no bot.open_id/);
  await assert.rejects(resolveBotIdentity(config(), {request: async () => {throw new Error('credential-value');}}), e => !e.message.includes('credential-value'));
});
test('HTTP and secure WebSocket use environment HTTPS proxy; NO_PROXY works for both', t => {
  proxyEnvironment(t); process.env.HTTPS_PROXY = 'http://127.0.0.1:12345';
  const n = createNetwork(); t.after(() => n.close());
  assert.equal(n.agent.getProxyForUrl('https://api.example.test/path'), process.env.HTTPS_PROXY);
  assert.equal(n.agent.getProxyForUrl('wss://socket.example.test/path'), process.env.HTTPS_PROXY);
  process.env.NO_PROXY = '.example.test';
  assert.equal(n.agent.getProxyForUrl('https://api.example.test/path'), '');
  assert.equal(n.agent.getProxyForUrl('wss://socket.example.test/path'), '');
  assert.equal(n.httpInstance.defaults.proxy, false); assert.equal(n.httpInstance.defaults.httpsAgent, n.agent);
});
test('explicit WSS proxy takes precedence without disclosing its value', t => {
  proxyEnvironment(t); process.env.HTTPS_PROXY = 'http://127.0.0.1:12345'; process.env.WSS_PROXY = 'http://127.0.0.1:12346';
  const n = createNetwork(); t.after(() => n.close());
  assert.equal(n.agent.getProxyForUrl('wss://example.test'), process.env.WSS_PROXY);
});
test('HTTP API adapter rejects non-2xx and returns the expected SDK response shape on loopback', async t => {
  proxyEnvironment(t);
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/error' ? 403 : 200, {'content-type': 'application/json'});
    res.end(JSON.stringify({code: req.url === '/error' ? 403 : 0, data: {fixture: true}}));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => {server.closeAllConnections(); server.close(resolve);}));
  const n = createNetwork(); t.after(() => n.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await n.httpInstance.get(base + '/ok'), {code: 0, data: {fixture: true}});
  await assert.rejects(n.httpInstance.get(base + '/error'), error => {
    const details = getHttpDiagnostics(error);
    assert.equal(error.response.status, 403);
    assert.equal(details.http_status, 403); assert.equal(details.code, 403);
    assert.equal(details.error_type, 'http_error'); assert.equal(details.request_phase, 'unknown');
    assert.ok(Number.isInteger(details.elapsed_ms) && details.elapsed_ms >= 0);
    return true;
  });
});
test('SDK Client create/reply encode payload and resolve token through injected HTTP adapter', async t => {
  const n = createNetwork(); t.after(() => n.close()); const calls = [];
  n.httpInstance.defaults.adapter = async request => {
    calls.push(request);
    const data = request.url.includes('tenant_access_token')
      ? {code: 0, tenant_access_token: 'fixture-token', expire: 7200}
      : {code: 0, data: {message_id: 'om_response'}};
    return {data, status: 200, statusText: 'OK', headers: {}, config: request};
  };
  const client = createClient(config(), n);
  assert.equal((await sendText(client, {receiveId: 'oc_fixture', text: 'hello', idempotencyKey: 'stable_key'})).ok, true);
  assert.equal((await sendText(client, {messageId: 'om_original', text: 'reply', idempotencyKey: 'reply_key', replyInThread: true})).ok, true);
  const create = calls.find(p => p.url.endsWith('/im/v1/messages'));
  const reply = calls.find(p => p.url.endsWith('/im/v1/messages/om_original/reply'));
  assert.equal(create.params.receive_id_type, 'chat_id');
  assert.equal(JSON.parse(create.data).uuid, 'stable_key'); assert.equal(JSON.parse(create.data).receive_id, 'oc_fixture');
  assert.equal(JSON.parse(reply.data).reply_in_thread, true); assert.equal(JSON.parse(reply.data).uuid, 'reply_key');
  assert.equal(JSON.parse(JSON.parse(reply.data).content).text, 'reply');
});
test('authentication, send and reply share a fixed 30-second HTTP timeout without automatic retries', async t => {
  const {client, calls} = httpFixture(t, 'fixed-http-timeout', request => isAuthentication(request)
    ? tokenResponse : {code: 0, data: {message_id: 'om_response'}});
  assert.equal((await sendText(client, {receiveId: 'oc_fixture', text: 'fixture'})).ok, true);
  assert.equal((await sendText(client, {messageId: 'om_original', text: 'fixture reply'})).ok, true);
  assert.deepEqual(calls.map(request => [new URL(request.url).pathname, request.timeout]), [
    ['/open-apis/auth/v3/tenant_access_token/internal', 30000],
    ['/open-apis/im/v1/messages', 30000],
    ['/open-apis/im/v1/messages/om_original/reply', 30000]
  ]);
});
for (const [name, failedPhase, options, phase, elapsed, code] of [
  ['authentication', 'authentication', {receiveId: 'oc_fixture'}, 'authentication', 30016, 'ECONNABORTED'],
  ['send', 'message', {receiveId: 'oc_fixture'}, 'send', 30004, 'ECONNABORTED'],
  ['reply', 'message', {messageId: 'om_original'}, 'reply', 30009, 'ETIMEDOUT']
]) test(`${name} timeout retains only safe per-request diagnostics and never retries`, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const {client, calls} = httpFixture(t, `timeout-${name}`, request => {
    const auth = isAuthentication(request);
    if (auth && failedPhase !== 'authentication') { now += 14326; return tokenResponse; }
    now += elapsed;
    throw Object.assign(new Error('private error text with token and message body'), {
      code, config: request, request: {headers: {authorization: 'private-header'}},
      response: undefined
    });
  });
  const result = await sendText(client, {...options, text: 'private message body', idempotencyKey: 'stable_operation'});
  assert.deepEqual(result, {ok: false, idempotency_key: 'stable_operation',
    status: failedPhase === 'authentication' ? 'not_sent' : 'delivery_unknown',
    request_phase: phase, error_type: 'timeout', error_code: code, elapsed_ms: elapsed});
  assert.equal(calls.length, failedPhase === 'authentication' ? 1 : 2);
  assert.ok(calls.every(request => request.timeout === 30000));
  if (failedPhase === 'authentication') assert.ok(calls.every(isAuthentication));
});
for (const [name, data, errorType] of [
  ['API failure', {code: 99991672, msg: 'private API message'}, 'api_error'],
  ['missing token', {code: 0, msg: 'private API message'}, 'invalid_response']
]) test(`authentication ${name} preserves status/code before SDK wrapping and never sends`, async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const {client, calls} = httpFixture(t, `auth-${errorType}`, () => { now += 1234; return data; });
  const result = await sendText(client, {receiveId: 'oc_fixture', text: 'private body', idempotencyKey: 'stable'});
  assert.deepEqual(result, {ok: false, idempotency_key: 'stable', status: 'not_sent',
    request_phase: 'authentication', error_type: errorType, elapsed_ms: 1234, http_status: 200, code: data.code});
  assert.equal(calls.length, 1); assert.ok(isAuthentication(calls[0]));
});
test('send API failure retains numeric API/HTTP codes and send duration without response content', async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const {client} = httpFixture(t, 'send-api-failure', request => {
    if (isAuthentication(request)) { now += 11000; return tokenResponse; }
    now += 700;
    return {code: 230001, msg: 'private error', data: {content: 'private body', token: 'private-token'}};
  });
  assert.deepEqual(await sendText(client, {receiveId: 'oc_fixture', text: 'private body', idempotencyKey: 'stable'}), {
    ok: false, idempotency_key: 'stable', status: 'api_error', request_phase: 'send',
    error_type: 'api_error', elapsed_ms: 700, http_status: 200, code: 230001
  });
});
test('unknown transport codes and error names cannot leak into send diagnostics', async t => {
  const {client} = httpFixture(t, 'unknown-error', request => {
    throw Object.assign(new Error('private error text'), {name: 'private error name', code: 'PRIVATE_TOKEN', config: request});
  });
  const result = await sendText(client, {receiveId: 'oc_fixture', text: 'private body'});
  assert.equal(result.status, 'not_sent'); assert.equal(result.request_phase, 'authentication');
  assert.equal(result.error_type, 'unknown_error'); assert.equal(result.error_code, undefined);
  assert.ok(Number.isInteger(result.elapsed_ms) && result.elapsed_ms >= 0);
  assert.ok(!/private/i.test(JSON.stringify(result)));
});
test('bot identity preserves safe authentication diagnostics for the startup CLI', async t => {
  const {client} = httpFixture(t, 'startup-auth-timeout', request => {
    throw Object.assign(new Error('private credentials'), {code: 'ECONNABORTED', config: request});
  });
  await assert.rejects(resolveBotIdentity(config(), client), error => {
    const details = getHttpDiagnostics(error);
    assert.equal(details.request_phase, 'authentication');
    assert.equal(details.error_type, 'timeout'); assert.equal(details.error_code, 'ECONNABORTED');
    assert.ok(Number.isInteger(details.elapsed_ms) && details.elapsed_ms >= 0);
    assert.ok(!JSON.stringify({error: error.message, ...details}).includes('private credentials'));
    return true;
  });
});
test('explicit retry reuses the exact payload/key while a changed message gets a new key', async t => {
  let sent = 0;
  const {client, calls} = httpFixture(t, 'manual-retry', request => {
    if (isAuthentication(request)) return tokenResponse;
    if (++sent === 1) throw Object.assign(new Error('private timeout'), {code: 'ECONNABORTED', config: request});
    return {code: 0, data: {message_id: `om_result_${sent}`}};
  });
  const operation = {receiveId: 'oc_fixture', receiveIdType: 'chat_id', text: 'Original message'};
  const first = await sendText(client, operation);
  assert.equal(first.status, 'delivery_unknown'); assert.equal(sent, 1);
  const retried = await sendText(client, {...operation, idempotencyKey: first.idempotency_key});
  assert.equal(retried.ok, true); assert.equal(retried.idempotency_key, first.idempotency_key);
  const changed = await sendText(client, {...operation, text: 'Changed message'});
  assert.equal(changed.ok, true); assert.notEqual(changed.idempotency_key, first.idempotency_key);
  const messageCalls = calls.filter(request => !isAuthentication(request));
  assert.equal(messageCalls.length, 3);
  assert.deepEqual(messageCalls[1].data, messageCalls[0].data);
  assert.deepEqual(messageCalls[1].params, messageCalls[0].params);
  assert.equal(JSON.parse(messageCalls[2].data).uuid, changed.idempotency_key);
  assert.equal(JSON.parse(JSON.parse(messageCalls[2].data).content).text, 'Changed message');
});
for (const [receiveId, receiveIdType] of [
  ['oc_private_fixture', 'chat_id'], ['oc_group_fixture', 'chat_id'], ['ou_recipient_fixture', 'open_id']
]) test(`known ${receiveId} sends with its selected ID type and no discovery request`, async t => {
  const n = createNetwork(); t.after(() => n.close()); const calls = [];
  n.httpInstance.defaults.adapter = async request => {
    calls.push(request);
    const data = request.url.includes('tenant_access_token')
      ? {code: 0, tenant_access_token: 'fixture-token', expire: 7200}
      : {code: 0, data: {message_id: 'om_requested'}};
    return {data, status: 200, statusText: 'OK', headers: {}, config: request};
  };
  const result = await sendText(createClient(config(), n), {receiveId, receiveIdType, text: 'Requested fixture', idempotencyKey: 'requested_send'});
  assert.deepEqual(result, {ok: true, message_id: 'om_requested', idempotency_key: 'requested_send'});
  // The SDK may reuse its cached tenant token from another client.
  const messageCalls = calls.filter(request => !request.url.includes('tenant_access_token'));
  assert.deepEqual(messageCalls.map(request => new URL(request.url).pathname), ['/open-apis/im/v1/messages']);
  assert.equal(messageCalls[0].params.receive_id_type, receiveIdType);
  assert.equal(JSON.parse(messageCalls[0].data).receive_id, receiveId);
});
test('SDK socket supports our domain, public agent and lifecycle callbacks without starting a network connection', t => {
  const n = createNetwork(); t.after(() => n.close());
  const s = createSocket(config(), n, {onReady() {}}); t.after(() => s.close({force: true}));
  assert.equal(s.getConnectionStatus().state, 'idle');
  assert.equal(s.agent, n.agent);
  assert.equal(s.handshakeTimeoutMs, 15000);
});
test('WebSocket endpoint discovery keeps its existing 15-second timeout', async t => {
  const n = createNetwork(); t.after(() => n.close()); const calls = [];
  n.httpInstance.defaults.adapter = async request => {
    calls.push(request);
    return {status: 200, statusText: 'OK', headers: {}, config: request, data: {code: 0, data: {
      URL: 'wss://socket.example.test/ws?device_id=fixture&service_id=fixture',
      ClientConfig: {PingInterval: 120, ReconnectCount: 1, ReconnectInterval: 10, ReconnectNonce: 1}
    }}};
  };
  const socket = createSocket(config(), n, {}); t.after(() => socket.close({force: true}));
  assert.deepEqual(await socket.pullConnectConfig(), {ok: true});
  assert.equal(calls.length, 1); assert.equal(calls[0].timeout, 15000);
  assert.equal(socket.getConnectionStatus().state, 'idle');
});
function clientWith(response, error) {
  let count = 0;
  const execute = async () => {count++; if (error) throw error; return response;};
  return {client: {im: {message: {create: execute, reply: execute}}}, count: () => count};
}
for (const [name, response, status] of [
  ['success', {code: 0, data: {message_id: 'om_result'}}, 'success'],
  ['API failure', {code: 230001, msg: 'sensitive text'}, 'api_error'],
  ['missing response', null, 'delivery_unknown'],
  ['missing message ID', {code: 0, data: {}}, 'delivery_unknown'],
  ['invalid success code', {code: '0', data: {message_id: 'om_false'}}, 'delivery_unknown']
]) test(`send handles ${name} with one attempt`, async () => {
  const c = clientWith(response), r = await sendText(c.client, {receiveId: 'oc_fixture', text: 'fixture', idempotencyKey: 'stable'});
  assert.equal(c.count(), 1); assert.equal(r.ok, status === 'success');
  if (!r.ok) assert.equal(r.status, status);
  assert.equal(r.idempotency_key, 'stable'); assert.ok(!JSON.stringify(r).includes('sensitive'));
});
test('ambiguous network failure is not retried and preserves idempotency key', async () => {
  const c = clientWith(null, new Error('secret URL and token'));
  const r = await sendText(c.client, {messageId: 'om_fixture', text: 'fixture', idempotencyKey: 'same_operation'});
  assert.equal(c.count(), 1); assert.equal(r.status, 'delivery_unknown'); assert.equal(r.idempotency_key, 'same_operation');
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('HTTP API failure exposes numeric status/code only', async () => {
  const c = clientWith(null, {response: {status: 403, data: {code: 99991663, msg: 'private details'}}});
  const r = await sendText(c.client, {receiveId: 'oc_fixture', text: 'fixture'});
  assert.equal(r.status, 'api_error'); assert.equal(r.http_status, 403); assert.equal(r.code, 99991663);
  assert.ok(!JSON.stringify(r).includes('private'));
});
test('outgoing text, ID and byte limits fail before a send', async () => {
  assert.throws(() => outgoingContent('   ')); assert.throws(() => outgoingContent('\ud800'));
  assert.throws(() => outgoingContent('\u4e2d'.repeat(7000))); assert.throws(() => outgoingContent('hi', 'a b'));
  const c = clientWith({code: 0});
  await assert.rejects(sendText(c.client, {text: 'hi'}), /receive-id/);
  await assert.rejects(sendText(c.client, {text: 'hi', messageId: '../bad'}), /message-id/);
  await assert.rejects(sendText(c.client, {text: 'hi', receiveId: 'fixture', receiveIdType: 'other'}), /receive-id-type/);
  assert.equal(c.count(), 0);
});
