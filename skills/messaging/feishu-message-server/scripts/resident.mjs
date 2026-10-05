import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { SafeError } from './config.mjs';
import { findProject } from './project.mjs';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const allowed = new Set(['health', 'identity', 'capabilities', 'inbox', 'inbox-page', 'send', 'reply']);
const fail = code => Object.assign(new SafeError(code), {code});
export function privatePath(filename, directory = false) {
  const st = fs.lstatSync(filename);
  if ((directory ? !st.isDirectory() : !st.isFile()) || st.isSymbolicLink() ||
      (st.mode & 0o077) || (process.getuid && st.uid !== process.getuid())) throw fail('unsafe-local-permissions');
}
function readPrivate(filename) {
  privatePath(path.dirname(filename), true); privatePath(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (fs.fstatSync(fd).size > 1024 * 1024) throw fail('local-file-too-large'); return fs.readFileSync(fd, 'utf8'); }
  finally { fs.closeSync(fd); }
}
function atomic(filename, value) {
  const temp = `${filename}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
  const dir = fs.openSync(path.dirname(filename), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
export function runtimeIdentity() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const project = findProject();
  return hash(fs.readFileSync(project.lockfile) + '\0' + fs.readFileSync(path.join(directory, '../package.json')) + '\0' + fs.readdirSync(directory).filter(n => n.endsWith('.mjs')).sort().map(n => n + '\0' + fs.readFileSync(path.join(directory, n))).join('\0'));
}
function same(a, b) { return a && b && a.app_id === b.app_id && a.brand === b.brand && a.runtime === b.runtime; }
export async function residentRequest({directory, identity, operation, args = {}, timeout = 65000}) {
  let endpoint;
  try { endpoint = JSON.parse(readPrivate(path.join(directory, 'endpoint.json'))); }
  catch { throw fail('resident-unavailable-no-fallback'); }
  if (endpoint.protocol !== 1 || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !same(endpoint.identity, identity)) throw fail('resident-binding-mismatch');
  // Fixed loopback destination; native HTTP deliberately never consults proxy env.
  // Provider HTTP retains createNetwork's original proxy/TLS policy.
  const body = JSON.stringify({operation, args, identity, instance: endpoint.instance});
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: endpoint.port, path: '/v1', method: 'POST', agent: false,
      headers: {'content-type': 'application/json', 'content-length': Buffer.byteLength(body)}}, res => {
      res.on('aborted', () => reject(fail('resident-delivery-unknown-no-fallback')));
      res.on('error', () => reject(fail('resident-delivery-unknown-no-fallback')));
      const chunks = []; let size = 0; res.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
      res.on('end', () => { try { const result = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))); if (res.statusCode !== 200) reject(fail(result.error ?? 'resident-rejected')); else resolve(result); } catch { reject(fail('resident-invalid-response')); } });
    });
    req.setTimeout(timeout, () => req.destroy());
    req.on('error', () => reject(fail(['send','reply'].includes(operation) ? 'resident-delivery-unknown-no-fallback' : 'resident-unavailable-no-fallback')));
    req.end(body);
  });
}

export async function startResident({directory, identity, handler, signal}) {
  fs.mkdirSync(directory, {mode: 0o700, recursive: true});
  privatePath(directory, true);
  const receipts = path.join(directory, 'receipts');
  fs.mkdirSync(receipts, {mode: 0o700, recursive: true}); privatePath(receipts, true);
  const lock = path.join(directory, 'resident.lock');
  try { fs.mkdirSync(lock, {mode: 0o700}); } catch { throw fail('resident-lock-exists-no-fallback'); }
  try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid), {mode: 0o600, flag: 'wx'}); }
  catch (error) { fs.rmdirSync(lock); throw error; }
  const endpointFile = path.join(directory, 'endpoint.json');
  const instance = `${process.pid}-${Date.now()}`;
  const pending = new Map();
  let closed = false;
  async function dispatch(value) {
    if (!value || !allowed.has(value.operation) || !same(value.identity, identity) || value.instance !== instance) throw fail('resident-binding-or-operation-mismatch');
    const args = value.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('invalid-arguments');
    if (!['send','reply'].includes(value.operation)) return handler(value.operation, args);
    const key = args.idempotencyKey;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(key)) throw fail('idempotency-key-required');
    const receipt = path.join(receipts, `${hash(key)}.json`);
    const fingerprint = hash(JSON.stringify({operation: value.operation, args, identity}));
    if (pending.has(key)) {
      const prior = pending.get(key); if (prior.fingerprint !== fingerprint) throw fail('idempotency-conflict');
      return prior.promise;
    }
    if (fs.existsSync(receipt)) {
      const record = JSON.parse(readPrivate(receipt));
      if (record.fingerprint !== fingerprint) throw fail('idempotency-conflict');
      return record.result ?? {ok: false, status: 'delivery_unknown', idempotency_key: key, error_code: 'resident-interrupted-no-retry'};
    }
    // Durable intent before any provider call. A crash remains unknown, never retried.
    atomic(receipt, {fingerprint});
    const promise = (async () => {
      let result;
      try { result = await handler(value.operation, args); }
      catch { result = {ok: false, status: 'delivery_unknown', idempotency_key: key, error_code: 'resident-handler-unknown'}; }
      try { atomic(receipt, {fingerprint, result}); }
      catch { return {ok: false, status: 'delivery_unknown', idempotency_key: key, error_code: 'resident-receipt-write-failed'}; }
      return result;
    })();
    pending.set(key, {fingerprint, promise});
    try { return await promise; } finally { pending.delete(key); }
  }
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => { if (!res.destroyed) { res.writeHead(status, {'content-type': 'application/json', 'connection': 'close'}); res.end(JSON.stringify(value)); } };
    if (req.method !== 'POST' || req.url !== '/v1' || req.headers.origin || req.headers['content-type'] !== 'application/json') {
      req.resume(); respond(403, {error: 'resident-request-rejected'}); return;
    }
    try {
      const chunks = []; let size = 0; for await (const part of req) { size += part.length; if (size > 100000) throw fail('request-too-large'); chunks.push(part); }
      respond(200, await dispatch(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)))));
    } catch (error) { respond(400, {error: error instanceof SafeError ? error.message : 'resident-request-failed'}); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.maxHeadersCount = 20;
  let closing;
  function close() {
    if (closed) return closing; closed = true;
    closing = (async () => { signal?.removeEventListener('abort', onAbort);
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...pending.values()].map(v => v.promise));
    // Do not let malformed/replaced discovery data prevent owned lock cleanup.
    try { if (fs.existsSync(endpointFile)) { const current = JSON.parse(readPrivate(endpointFile)); if (current.instance === instance) fs.unlinkSync(endpointFile); } } catch { /* preserve unverified endpoint */ }
    try { fs.unlinkSync(path.join(lock, 'pid')); } finally { fs.rmdirSync(lock); }
    })();
    return closing;
  }
  const onAbort = () => { close().catch(() => {}); };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    atomic(endpointFile, {protocol: 1, port: server.address().port, identity, instance});
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) await close();
    return {close, port: server.address()?.port, identity};
  } catch (error) { await close(); throw error; }
}
