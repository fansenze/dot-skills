/** Synthetic adapter. Never contacts an external service. */
import fs from 'node:fs';
import path from 'node:path';
export function createConnector(settings) {
  const read = (name, fallback) => { try { return fs.readFileSync(path.join(settings.root, name), 'utf8'); } catch { return fallback; } };
  const append = (name, value) => {
    const fd = fs.openSync(path.join(settings.root, name), 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  async function send(message) {
    const mode = read('mode', 'accepted').trim(); append('calls.jsonl', message);
    if (mode === 'not_sent') return {status: 'not_sent', idempotency_key: message.idempotency_key, retryable: true, error_code: 'ETIMEDOUT'};
    if (mode === 'api_error') return {status: 'api_error', idempotency_key: message.idempotency_key, code: 400};
    if (mode === 'reaction-permission-error' && message.emoji_type) return {status: 'api_error', idempotency_key: message.idempotency_key, code: 99991672, retryable: false};
    append('effects.jsonl', message);
    if (mode === 'crash-after-effect') process.kill(process.pid, 'SIGKILL');
    if (mode === 'throw-after-effect') throw new Error('PRIVATE-DIAGNOSTIC-MUST-NOT-LEAK');
    if (mode === 'malformed') return 'not valid result JSON';
    return {status: 'api_accepted', idempotency_key: message.idempotency_key, message_id: 'provider-message-id'};
  }
  return {
    capabilities: () => ({presentation:settings.presentation ?? 'feishu', ...(settings.react !== undefined ? {react:settings.react} : {}), protocol_version: settings.protocol ?? 1, name: settings.name ?? 'fixture',
      formats: settings.formats ?? ['text', 'markdown', 'card'], send: settings.send ?? true, reply: settings.reply ?? true, receive: settings.receive ?? true, durable_cursor: settings.durable_cursor ?? true}),
    react: settings.react ? async message => { const r=await send(message); if(r.status!=='api_accepted')return r; const {message_id,...rest}=r; return {...rest,reaction_id:'reaction-fixture'}; } : undefined,
    send: settings.send === false ? undefined : send, reply: settings.reply === false ? undefined : send,
    async receive({cursor, limit}) {
      const rows = JSON.parse(read('inbox.json', '[]')), start = cursor === null ? 0 : Number(cursor);
      if (!Number.isInteger(start) || start > rows.length) throw new Error('cursor reset');
      const events = rows.slice(start, start + limit).map((e, i) => ({...e, cursor: String(start + i + 1)}));
      return {events, next_cursor: String(start + events.length), has_more: start + events.length < rows.length};
    }
  };
}
