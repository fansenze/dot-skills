/** Versioned task/server connector boundary. Modules are explicitly trusted code. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_VERSION = 1;
export class ConnectorError extends Error {}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
export function requireText(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new ConnectorError(`Invalid ${name}`);
  return value;
}
export function capabilities(value) {
  if (value?.protocol_version !== PROTOCOL_VERSION || !Array.isArray(value.formats) ||
    value.formats.some(f => !['text', 'markdown', 'card', 'image', 'file'].includes(f)) ||
    ['send', 'reply', 'receive', 'durable_cursor'].some(k => typeof value[k] !== 'boolean')) throw new ConnectorError('Incompatible connector capabilities');
  if (value.presentation !== undefined && !['default','feishu'].includes(value.presentation)) throw new ConnectorError('Unsupported presentation channel');
  if (value.react !== undefined && typeof value.react !== 'boolean') throw new ConnectorError('Invalid reaction capability');
  if (value.upload !== undefined && typeof value.upload !== 'boolean') throw new ConnectorError('Invalid upload capability');
  return {presentation:value.presentation ?? 'default', react:value.react ?? false, protocol_version: 1, name: requireText(value.name, 'connector name'), formats: [...new Set(value.formats)],
    send: value.send, reply: value.reply, receive: value.receive, durable_cursor: value.durable_cursor,...(value.upload !== undefined ? {upload:value.upload} : {})};
}
export async function loadConnector(connection) {
  if (!path.isAbsolute(connection.module)) throw new ConnectorError('Connector module must be an absolute path');
  const hash = digest(fs.readFileSync(connection.module));
  if (connection.module_sha256 && hash !== connection.module_sha256) throw new ConnectorError('Connector code changed; register a new reviewed binding');
  const module = await import(pathToFileURL(connection.module).href);
  if (typeof module.createConnector !== 'function') throw new ConnectorError('Module must export createConnector(settings)');
  const adapter = await module.createConnector(structuredClone(connection.settings));
  const caps = capabilities(await adapter.capabilities());
  for (const method of ['send', 'reply', 'receive', 'react']) {
    if (caps[method] && typeof adapter[method] !== 'function') throw new ConnectorError(`Connector lacks ${method}`);
  }
  if (caps.upload && ['inspectUpload','upload','uploadStatus'].some(method=>typeof adapter[method] !== 'function')) throw new ConnectorError('Connector lacks attachment methods');
  if (connection.capabilities && JSON.stringify(caps) !== JSON.stringify(connection.capabilities)) throw new ConnectorError('Connector capabilities changed; review a new binding');
  return {adapter, capabilities: caps, module_sha256: hash};
}
export function sendResult(raw, key, operation = 'message') {
  // Invalid/absent JSON or an exception is ambiguous, never evidence of no send.
  if (!raw || raw.idempotency_key !== key || !['api_accepted', 'not_sent', 'api_error', 'delivery_unknown'].includes(raw.status)) {
    return {status: 'delivery_unknown', idempotency_key: key, error_code: 'invalid-adapter-result', retryable: false};
  }
  const resultId = operation === 'react' ? 'reaction_id' : 'message_id';
  if (raw.status === 'api_accepted' && (typeof raw[resultId] !== 'string' || !raw[resultId])) return sendResult(null, key, operation);
  const result = {status: raw.status, idempotency_key: key, retryable: raw.status === 'not_sent' && raw.retryable === true};
  if (raw[resultId]) {
    try { result[resultId] = requireText(raw[resultId], resultId); }
    catch { return sendResult(null, key, operation); }
  }
  for (const k of ['parent_id','root_id','thread_id']) if (typeof raw[k] === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(raw[k])) result[k]=raw[k];
  for (const k of ['error_code', 'request_phase']) if (typeof raw[k] === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw[k])) result[k] = raw[k];
  for (const k of ['code', 'http_status', 'elapsed_ms']) if (Number.isSafeInteger(raw[k])) result[k] = raw[k];
  return result;
}
export async function bounded(operation, timeout = 75000) {
  const controller = new AbortController(); let timer;
  try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ConnectorError('Adapter operation timed out')); }, timeout);
  })]); } finally { clearTimeout(timer); }
}
