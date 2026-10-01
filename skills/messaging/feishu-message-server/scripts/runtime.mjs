import fs from 'node:fs';
import path from 'node:path';
import { SafeError, privateDirectory } from './config.mjs';
import { Inbox } from './messages.mjs';
import { createNetwork, createClient, resolveBotIdentity, createDispatcher, createSocket } from './transport.mjs';

const events = new Set(['listener_starting', 'bot_identity_resolved', 'transport_connected', 'transport_reconnecting',
  'transport_reconnected', 'transport_failed', 'listener_stopped', 'message_received', 'message_duplicate',
  'message_ignored', 'storage_failed']);
const reasons = new Set(['wrong_event', 'outside_receive_scope', 'missing_message_id']);

export function createLog(stateDir, output = line => process.stdout.write(line + '\n')) {
  privateDirectory(stateDir);
  const filename = path.join(stateDir, 'server.log');
  return (event, detail = {}) => {
    if (!events.has(event)) return;
    const record = {time: new Date().toISOString(), event};
    if (reasons.has(detail.reason)) record.reason = detail.reason;
    if (['feishu', 'lark'].includes(detail.brand)) record.brand = detail.brand;
    const line = JSON.stringify(record);
    if (fs.existsSync(filename) && fs.statSync(filename).size > 2 * 1024 * 1024) {
      if (fs.existsSync(filename + '.1')) fs.renameSync(filename + '.1', filename + '.2');
      fs.renameSync(filename, filename + '.1');
    }
    fs.appendFileSync(filename, line + '\n', {mode: 0o600});
    fs.chmodSync(filename, 0o600);
    output(line);
  };
}

export function acquireLock(stateDir) {
  privateDirectory(stateDir);
  const directory = path.join(stateDir, 'node-listener.lock');
  try { fs.mkdirSync(directory, {mode: 0o700}); }
  catch (error) {
    if (error.code === 'EEXIST') throw new SafeError('Listener lock exists; stop the existing listener. If it crashed, verify the PID in .local/node-listener.lock/pid before removing the stale lock directory');
    throw new SafeError('Cannot create listener lock');
  }
  try { fs.writeFileSync(path.join(directory, 'pid'), String(process.pid) + '\n', {mode: 0o600, flag: 'wx'}); }
  catch (error) { fs.rmdirSync(directory); throw error; }
  return () => { fs.unlinkSync(path.join(directory, 'pid')); fs.rmdirSync(directory); };
}

export async function startListener(config, {stateDir, signal, readyTimeoutMs = 45000, log = createLog(stateDir),
  networkFactory = createNetwork, clientFactory = createClient, socketFactory = createSocket} = {}) {
  const release = acquireLock(stateDir);
  let network, inbox, socket, timer, onAbort;
  try {
    log('listener_starting', {brand: config.brand});
    if (!/^cli_[0-9a-fA-F]{16}$/.test(config.app_id)) throw new SafeError('app_id must be a self-built app ID in cli_ format');
    network = networkFactory();
    inbox = new Inbox(path.join(stateDir, 'messages.sqlite3'));
    await resolveBotIdentity(config, clientFactory(config, network));
    log('bot_identity_resolved');
    if (signal?.aborted) return;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const dispatcher = createDispatcher(config, inbox, log, () => {
      log('storage_failed'); finish(new SafeError('Inbox write failed; listener stopped without acknowledging persistence'));
    });
    socket = socketFactory(config, network, {
      onReady: () => { clearTimeout(timer); log('transport_connected', {brand: config.brand}); },
      onReconnecting: () => log('transport_reconnecting'),
      onReconnected: () => log('transport_reconnected'),
      onError: () => { log('transport_failed'); finish(new SafeError('Long connection failed; check credentials, long-connection mode, domain and network')); }
    });
    onAbort = () => finish();
    signal?.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => finish(new SafeError('Long connection was not ready within 45 seconds; check app settings, credentials and proxy')), readyTimeoutMs);
    await socket.start({eventDispatcher: dispatcher});
    const error = await done;
    if (error) throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    socket?.close({force: true});
    network?.close();
    inbox?.close();
    release();
    log('listener_stopped');
  }
}
