import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fromMapping } from '../scripts/config.mjs';
import { createNetwork, createClient, createSocket, resolveBotIdentity, sendText, outgoingContent } from '../scripts/transport.mjs';

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
  await assert.rejects(n.httpInstance.get(base + '/error'), e => e.response.status === 403);
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
