import * as lark from '@larksuiteoapi/node-sdk';
import { ProxyAgent } from 'proxy-agent';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SafeError } from './config.mjs';
import { extractMessage } from './messages.mjs';
import { formatContent } from './formats.mjs';

// The SDK may log credentials, signed socket URLs, raw events or HTTP errors.
// Lifecycle callbacks below are the only source of transport logs.
export const silentLogger = Object.freeze(Object.fromEntries(
  ['trace', 'debug', 'info', 'warn', 'error'].map(k => [k, () => {}])));

// Keep diagnostics separate from SDK/Axios objects, which can contain secrets.
const httpDiagnostics = new WeakMap();
const transportCodes = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ERR_NETWORK',
  'ERR_CANCELED', 'ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']);

export function getHttpDiagnostics(value) { return httpDiagnostics.get(value) ?? {}; }
function rememberHttpDiagnostics(value, details) {
  if (value && typeof value === 'object') httpDiagnostics.set(value, Object.freeze(details));
  return value;
}
function responseCodes(response) {
  return {
    ...(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? {http_status: response.status} : {}),
    ...(Number.isSafeInteger(response?.data?.code) ? {code: response.data.code} : {})
  };
}
function transportFailure(error) {
  const errorCode = transportCodes.has(error?.code) ? error.code : undefined;
  const codes = responseCodes(error?.response);
  const errorType = ['ECONNABORTED', 'ETIMEDOUT'].includes(errorCode) ? 'timeout'
    : codes.http_status ? 'http_error' : errorCode ? 'network_error' : 'unknown_error';
  return {error_type: errorType, ...(errorCode ? {error_code: errorCode} : {}), ...codes};
}
function requestPhase(request) {
  let pathname;
  try { pathname = new URL(request.url, 'https://request.invalid').pathname; }
  catch { return 'unknown'; }
  if (pathname === '/open-apis/auth/v3/tenant_access_token/internal') return 'authentication';
  if (request.method?.toUpperCase() === 'POST') {
    if (pathname === '/open-apis/im/v1/messages') return 'send';
    if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reply$/.test(pathname)) return 'reply';
    if (/^\/open-apis\/im\/v1\/messages\/[^/]+\/reactions$/.test(pathname)) return 'reaction';
  }
  if (pathname === '/open-apis/bot/v3/info') return 'bot_identity';
  if (pathname === '/callback/ws/endpoint') return 'websocket_discovery';
  return 'unknown';
}

export function createNetwork({signal} = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new SafeError('TLS verification must remain enabled');
  const cancellation = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const agent = new ProxyAgent({keepAlive: true});
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
    httpAgent: agent, httpsAgent: agent, proxy: false, signal: requestSignal,
    timeout: 30000, maxRedirects: 0, maxContentLength: 4 * 1024 * 1024
  });
  const requests = new WeakMap();
  httpInstance.interceptors.request.use(request => {
    requests.set(request, {phase: requestPhase(request), started: performance.now()});
    return request;
  });
  const timing = request => {
    const recorded = requests.get(request);
    return recorded ? {request_phase: recorded.phase, elapsed_ms: Math.max(0, Math.round(performance.now() - recorded.started))}
      : {request_phase: 'unknown'};
  };
  httpInstance.interceptors.response.use(response => {
    const details = {...timing(response.config), ...responseCodes(response)};
    // Preserve auth business errors before the SDK turns them into plain Errors.
    if (details.request_phase === 'authentication' &&
      (response.data?.code !== 0 || typeof response.data?.tenant_access_token !== 'string' || !response.data.tenant_access_token)) {
      throw rememberHttpDiagnostics(new SafeError('Authentication response did not provide a usable token'), {
        ...details, error_type: Number.isSafeInteger(response.data?.code) && response.data.code !== 0 ? 'api_error' : 'invalid_response'
      });
    }
    const body = response.config.$return_headers ? {data: response.data, headers: response.headers} : response.data;
    return rememberHttpDiagnostics(body, details);
  }, error => {
    rememberHttpDiagnostics(error, {...timing(error?.config), ...transportFailure(error)});
    throw error;
  });
  return {agent, httpInstance, close() {
    cancellation.abort();
    agent.destroy(); agent.httpAgent.destroy(); agent.httpsAgent.destroy();
  }};
}

export function createClient(config, network) {
  // Per-client, memory-only cache; never mix equal app IDs on different domains.
  const entries = new Map();
  const cache = {
    get(key) { const item = entries.get(key); if (item && (!item.expire || item.expire > Date.now())) return item.value; entries.delete(key); },
    set(key, value, expire) { entries.set(key, {value, expire}); return true; },
    remove(key) { return entries.delete(key); }
  };
  const client = new lark.Client({appId: config.app_id, appSecret: config.app_secret,
    domain: config.domain, appType: lark.AppType.SelfBuild, cache,
    httpInstance: network.httpInstance, logger: silentLogger});
  // Pinned SDK does not coalesce simultaneous cold/expired-token requests.
  const acquire = client.tokenManager.getCustomTenantAccessToken.bind(client.tokenManager);
  let acquiring;
  client.tokenManager.getCustomTenantAccessToken = () => {
    if (!acquiring) acquiring = Promise.resolve().then(acquire).finally(() => { acquiring = undefined; });
    return acquiring;
  };
  return client;
}

export async function resolveBotIdentity(config, client, signal) {
  if (signal?.aborted) return config;
  if (config.bot_open_id) return config;
  let response;
  try { response = await client.request({method: 'GET', url: '/open-apis/bot/v3/info', ...(signal ? {signal} : {})}); }
  catch (error) {
    throw rememberHttpDiagnostics(new SafeError('Bot identity lookup failed; check app credentials, bot capability, domain and network'),
      {...transportFailure(error), ...getHttpDiagnostics(error)});
  }
  if (response?.code !== 0 || typeof response?.bot?.open_id !== 'string' || !response.bot.open_id) {
    throw rememberHttpDiagnostics(new SafeError('Bot identity lookup returned no bot.open_id; check credentials and bot capability'), {
      ...getHttpDiagnostics(response), ...responseCodes({data: response}),
      error_type: Number.isSafeInteger(response?.code) && response.code !== 0 ? 'api_error' : 'invalid_response'
    });
  }
  if (signal?.aborted) return config;
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

// Compatibility wrapper for pinned SDK 1.74.0. Keep its discovery/state machine,
// but validate the response before its early data destructuring and suppress
// stale discovery results before the SDK can construct a WebSocket.
export function createSocket(config, network, callbacks) {
  let generation = 0, closed = false;
  const cancellation = new AbortController();
  const httpInstance = {request: async request => {
    const signal = request.signal || network.httpInstance.defaults.signal;
    const response = await network.httpInstance.request({...request,
      signal: signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal});
    if (!Number.isSafeInteger(response?.code)) throw new SafeError('Invalid WebSocket discovery response');
    // Let the SDK retain its exact code-based retry policy; never destructure
    // an absent data field on a business rejection.
    if (response.code !== 0) return {...response, data: {}};
    const data = response.data, options = data?.ClientConfig;
    let url;
    try { url = new URL(data?.URL); } catch { /* rejected below */ }
    if (!url || url.protocol !== 'wss:' || !url.hostname || !options ||
      !Number.isFinite(options.PingInterval) || options.PingInterval <= 0 ||
      !Number.isInteger(options.ReconnectCount) || options.ReconnectCount < -1 ||
      !Number.isFinite(options.ReconnectInterval) || options.ReconnectInterval < 0 ||
      !Number.isFinite(options.ReconnectNonce) || options.ReconnectNonce < 0) {
      throw new SafeError('Invalid WebSocket discovery response');
    }
    return response;
  }};
  const socket = new lark.WSClient({appId: config.app_id, appSecret: config.app_secret,
    domain: config.domain, httpInstance, agent: network.agent,
    logger: silentLogger, autoReconnect: true, handshakeTimeoutMs: 15000,
    ...callbacks});
  const pull = socket.pullConnectConfig.bind(socket);
  socket.pullConnectConfig = async () => {
    const current = generation;
    if (closed) return {ok: false, retryable: false};
    const result = await pull();
    return closed || current !== generation ? {ok: false, retryable: false} : result;
  };
  // The SDK awaits pullConnectConfig before calling connect, so close can land
  // in that intervening microtask even after the discovery guard passed.
  const connect = socket.connect.bind(socket);
  socket.connect = () => closed ? Promise.resolve(false) : connect();
  const close = socket.close.bind(socket);
  socket.close = params => {
    closed = true;
    generation++;
    cancellation.abort();
    return close(params);
  };
  // A runtime owns one socket for one listener lifetime. Reuse after close is
  // deliberately unsupported: construct a new socket for the next listener.
  const start = socket.start.bind(socket);
  socket.start = params => {
    if (closed) throw new SafeError('Closed socket cannot be restarted; create a new listener');
    generation++;
    return start(params);
  };
  return socket;
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
  return sendData(client, data, {receiveId, receiveIdType, messageId, replyInThread});
}

export async function sendMessage(client, {format = 'text', body, idempotencyKey = randomUUID(), ...target}) {
  if (format === 'text') return sendText(client, {...target, text: body, idempotencyKey});
  const key = outgoingContent('validate key', idempotencyKey).uuid;
  const data = {...formatContent(format, body), uuid: key};
  if (Buffer.byteLength(data.content, 'utf8') > 28000) throw new SafeError('Card JSON must not exceed 28000 UTF-8 bytes');
  return sendData(client, data, target);
}

/** A reaction is an explicit transport operation, never an automatic receive hook. */
export async function addReaction(client, {messageId, emojiType, idempotencyKey = randomUUID()}) {
  const base = {idempotency_key:outgoingContent('validate key',idempotencyKey).uuid};
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(messageId)) throw new SafeError('A valid message-id is required');
  if (typeof emojiType !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(emojiType)) throw new SafeError('A valid case-sensitive emoji-type is required');
  try {
    const response = await client.im.messageReaction.create({path:{message_id:messageId},data:{reaction_type:{emoji_type:emojiType}}});
    if (response?.code === 0 && typeof response?.data?.reaction_id === 'string' && response.data.reaction_id) return {ok:true,...base,reaction_id:response.data.reaction_id};
    const apiError = Number.isSafeInteger(response?.code) && response.code !== 0;
    return {ok:false,...base,status:apiError ? 'api_error' : 'delivery_unknown',request_phase:'reaction',...getHttpDiagnostics(response),
      ...responseCodes({data:response}),error_type:apiError ? 'api_error' : 'invalid_response'};
  } catch (error) {
    const details = {request_phase:'unknown',...transportFailure(error),...getHttpDiagnostics(error)};
    return {ok:false,...base,status:details.request_phase === 'authentication' ? 'not_sent' : details.http_status >= 400 && details.http_status < 500 ? 'api_error' : 'delivery_unknown',...details};
  }
}

async function sendData(client, data, {receiveId, receiveIdType = 'chat_id', messageId, replyInThread = false}) {
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
      const context = Object.fromEntries(['parent_id','root_id','thread_id'].filter(k=>typeof response.data[k]==='string'&&/^[^\s\x00-\x1f\x7f]{1,256}$/u.test(response.data[k])).map(k=>[k,response.data[k]]));
      return {ok: true, ...base, message_id: response.data.message_id, ...context};
    }
    const apiError = Number.isSafeInteger(response?.code) && response.code !== 0;
    return {ok: false, ...base, status: apiError ? 'api_error' : 'delivery_unknown',
      request_phase: messageId !== undefined ? 'reply' : 'send', ...getHttpDiagnostics(response),
      ...responseCodes({data: response}), error_type: apiError ? 'api_error' : 'invalid_response'};
  } catch (error) {
    const details = {request_phase: 'unknown', ...transportFailure(error), ...getHttpDiagnostics(error)};
    const status = details.request_phase === 'authentication' ? 'not_sent'
      : details.http_status >= 400 && details.http_status < 500 ? 'api_error' : 'delivery_unknown';
    return {ok: false, ...base, status, ...details};
  }
}
