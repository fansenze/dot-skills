import * as lark from '@larksuiteoapi/node-sdk';
import { ProxyAgent } from 'proxy-agent';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { SafeError } from './config.mjs';
import { extractMessage } from './messages.mjs';

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
  }
  if (pathname === '/open-apis/bot/v3/info') return 'bot_identity';
  if (pathname === '/callback/ws/endpoint') return 'websocket_discovery';
  return 'unknown';
}

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
