import {uiTime} from '../presentation.mjs';
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
    value.formats.some(f => !['text', 'markdown', 'card'].includes(f)) ||
    ['send', 'reply', 'receive', 'durable_cursor'].some(k => typeof value[k] !== 'boolean')) throw new ConnectorError('Incompatible connector capabilities');
  return {protocol_version: 1, name: requireText(value.name, 'connector name'), formats: [...new Set(value.formats)],
    send: value.send, reply: value.reply, receive: value.receive, durable_cursor: value.durable_cursor};
}
export async function loadConnector(connection) {
  if (!path.isAbsolute(connection.module)) throw new ConnectorError('Connector module must be an absolute path');
  const hash = digest(fs.readFileSync(connection.module));
  if (connection.module_sha256 && hash !== connection.module_sha256) throw new ConnectorError('Connector code changed; register a new reviewed binding');
  const module = await import(pathToFileURL(connection.module).href);
  if (typeof module.createConnector !== 'function') throw new ConnectorError('Module must export createConnector(settings)');
  const adapter = await module.createConnector(structuredClone(connection.settings));
  const caps = capabilities(await adapter.capabilities());
  for (const method of ['render', 'send', 'reply', 'receive']) {
    if ((method === 'render' || caps[method]) && typeof adapter[method] !== 'function') throw new ConnectorError(`Connector lacks ${method}`);
  }
  if (connection.capabilities && JSON.stringify(caps) !== JSON.stringify(connection.capabilities)) throw new ConnectorError('Connector capabilities changed; review a new binding');
  return {adapter, capabilities: caps, module_sha256: hash};
}
export function sendResult(raw, key) {
  // Invalid/absent JSON or an exception is ambiguous, never evidence of no send.
  if (!raw || raw.idempotency_key !== key || !['api_accepted', 'not_sent', 'api_error', 'delivery_unknown'].includes(raw.status)) {
    return {status: 'delivery_unknown', idempotency_key: key, error_code: 'invalid-adapter-result', retryable: false};
  }
  if (raw.status === 'api_accepted' && (typeof raw.message_id !== 'string' || !raw.message_id)) return sendResult(null, key);
  const result = {status: raw.status, idempotency_key: key, retryable: raw.status === 'not_sent' && raw.retryable === true};
  if (raw.message_id) {
    try { result.message_id = requireText(raw.message_id, 'message ID'); }
    catch { return sendResult(null, key); }
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
const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/([\\`*_{}\[\]()#!|>~])/g, '\\$1');
export function renderText(document, markdown = false) {
  const safe = markdown ? escape : String;
  return [safe(document.title)+' · '+safe(uiTime(document.updated_at)), ...document.rows.map(row => row.map(safe).join(' · ')), ...document.details.map(safe)].filter(Boolean).join('\n');
}
