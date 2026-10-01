import * as lark from '@larksuiteoapi/node-sdk';
import { ProxyAgent } from 'proxy-agent';
import { randomUUID } from 'node:crypto';
import { SafeError } from './config.mjs';
import { extractMessage } from './messages.mjs';

// The SDK may log credentials, signed socket URLs, raw events or HTTP errors.
// Lifecycle callbacks below are the only source of transport logs.
export const silentLogger = Object.freeze(Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error'].map(k => [k, () => {}])));

export function createNetwork() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new SafeError('TLS verification must remain enabled');
  const agent = new ProxyAgent();
  const envProxy = agent.getProxyForUrl;
  agent.getProxyForUrl = (url, request) => {
    const parsed = new URL(url);
    // proxy-from-env uses protocol-specific variables. Match the old working
    // secure-socket behavior: WSS_PROXY if explicit, otherwise HTTPS_PROXY.
    if (parsed.protocol === 'wss:' && !(process.env.wss_proxy || process.env.WSS_PROXY)) parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:' && !(process.env.ws_proxy || process.env.WS_PROXY)) parsed.protocol = 'http:';
    return envProxy(parsed.href, request);
  };
  const httpInstance = lark.defaultHttpInstance.create({
    httpAgent: agent, httpsAgent: agent, proxy: false,
    timeout: 15000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024
  });
  httpInstance.interceptors.response.use(response => response.config.$return_headers
    ? {data: response.data, headers: response.headers} : response.data);
  return {agent, httpInstance, close() {
    agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy();
  }};
}

export function createClient(config, network) {
  return new lark.Client({appId: config.app_id, appSecret: config.app_secret,
    domain: config.domain, appType: lark.AppType.SelfBuild,
    httpInstance: network.httpInstance, logger: silentLogger});
}

export async function resolveBotIdentity(config, client) {
  if (config.bot_open_id) return config;
  let response;
  try { response = await client.request({method: 'GET', url: '/open-apis/bot/v3/info'}); }
  catch { throw new SafeError('Bot identity lookup failed; check app credentials, bot capability, domain and network'); }
  if (response?.code !== 0 || typeof response?.bot?.open_id !== 'string' || !response.bot.open_id) {
    throw new SafeError('Bot identity lookup returned no bot.open_id; check credentials and bot capability');
  }
  config.bot_open_id = response.bot.open_id;
  return config;
}

export function createDispatcher(config, inbox, log = () => {}, onStorageError = () => {}) {
  return new lark.EventDispatcher({logger: silentLogger}).register({
    'im.message.receive_v1': async data => {
      // The official Node dispatcher flattens the schema/header/event envelope.
      const {message, reason} = extractMessage({schema: data.schema,
        header: {event_type: data.event_type, app_id: data.app_id, tenant_key: data.tenant_key, event_id: data.event_id},
        event: {sender: data.sender, message: data.message}}, config);
      if (!message) { log('message_ignored', {reason}); return; }
      let inserted;
      try { inserted = inbox.put(message); }
      catch { onStorageError(); throw new SafeError('Inbox persistence failed'); }
      log(inserted ? 'message_received' : 'message_duplicate');
      // Intentionally no reply, shell, AI, tool, agent, or task dispatch here.
    }
  });
}

export function createSocket(config, network, callbacks) {
  return new lark.WSClient({appId: config.app_id, appSecret: config.app_secret,
    domain: config.domain, httpInstance: network.httpInstance, agent: network.agent,
    logger: silentLogger, autoReconnect: true, handshakeTimeoutMs: 15000,
    ...callbacks});
}

export function outgoingContent(text, idempotencyKey = randomUUID()) {
  if (typeof text !== 'string' || !text.trim() || !text.isWellFormed()) throw new SafeError('Text must be non-empty valid Unicode');
  const content = JSON.stringify({text});
  if (Buffer.byteLength(content, 'utf8') > 20000) throw new SafeError('Text JSON must not exceed 20000 UTF-8 bytes');
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(idempotencyKey)) {
    throw new SafeError('idempotency-key must be 1..50 ASCII letters, digits, underscores or hyphens');
  }
  return {content, msg_type: 'text', uuid: idempotencyKey};
}

export async function sendText(client, {text, idempotencyKey, receiveId, receiveIdType = 'chat_id', messageId, replyInThread = false}) {
  const data = outgoingContent(text, idempotencyKey);
  if (messageId !== undefined) {
    if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(messageId)) throw new SafeError('A valid message-id is required');
  } else {
    if (typeof receiveId !== 'string' || !receiveId.trim()) throw new SafeError('receive-id is required');
    if (!['chat_id', 'open_id', 'user_id', 'union_id', 'email'].includes(receiveIdType)) throw new SafeError('Unsupported receive-id-type');
  }
  const base = {idempotency_key: data.uuid};
  try {
    const response = messageId !== undefined
      ? await client.im.message.reply({path: {message_id: messageId}, data: {...data, reply_in_thread: replyInThread}})
      : await client.im.message.create({params: {receive_id_type: receiveIdType}, data: {...data, receive_id: receiveId}});
    if (response?.code === 0 && typeof response?.data?.message_id === 'string' && response.data.message_id) {
      return {ok: true, ...base, message_id: response.data.message_id};
    }
    return {ok: false, ...base, status: Number.isInteger(response?.code) && response.code !== 0 ? 'api_error' : 'delivery_unknown',
      ...(Number.isInteger(response?.code) ? {code: response.code} : {})};
  } catch (error) {
    const status = error?.response?.status;
    return {ok: false, ...base, status: Number.isInteger(status) && status >= 400 && status < 500 ? 'api_error' : 'delivery_unknown',
      ...(Number.isInteger(status) ? {http_status: status} : {}),
      ...(Number.isInteger(error?.response?.data?.code) ? {code: error.response.data.code} : {})};
  }
}
