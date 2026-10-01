import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { object, privateDirectory } from './config.mjs';

export class Inbox {
  constructor(filename) {
    privateDirectory(path.dirname(filename));
    const fd = fs.openSync(filename, 'a', 0o600);
    fs.closeSync(fd);
    fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename, {timeout: 750});
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS messages (
        app_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
        event_id TEXT NOT NULL, message_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        PRIMARY KEY(app_id, tenant_key, message_id),
        UNIQUE(app_id, tenant_key, event_id))`);
    this.insert = this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?)');
  }
  put(m) {
    // One SQLite autocommit transaction; durable write completes before SDK ACK.
    return this.insert.run(m.app_id, m.tenant_key, m.event_id, m.message_id, JSON.stringify(m)).changes === 1;
  }
  close() { this.db.close(); }
}

export function readInbox(filename, limit = 20, showText = false) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be 1..1000');
  if (!fs.existsSync(filename)) return [];
  const db = new DatabaseSync(filename, {readOnly: true, timeout: 750});
  try {
    return db.prepare('SELECT message_json FROM messages ORDER BY rowid DESC LIMIT ?').all(limit)
      .map(({message_json}) => {
        const message = JSON.parse(message_json);
        if (!showText) { delete message.text; delete message.content; }
        return message;
      });
  } finally { db.close(); }
}

const nonempty = s => typeof s === 'string' && s.length > 0;

export function extractMessage(payload, config) {
  payload = object(payload);
  const header = object(payload.header), event = object(payload.event);
  const sender = object(event.sender), message = object(event.message), senderId = object(sender.sender_id);
  const reject = reason => ({message: null, reason});
  if (header.event_type !== 'im.message.receive_v1') return reject('wrong_event');
  const privateChat = message.chat_type === 'p2p';
  const mentionsBot = Array.isArray(message.mentions) && message.mentions.some(
    mention => config.bot_open_id && object(object(mention).id).open_id === config.bot_open_id);
  if (!privateChat && !(message.chat_type === 'group' && mentionsBot)) return reject('outside_receive_scope');
  if (!nonempty(message.message_id)) return reject('missing_message_id');
  // Keep all message types as data. Do not infer tasks or fetch attachments.
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? {});
  let text;
  if (message.message_type === 'text') {
    try { const parsed = JSON.parse(content); if (typeof parsed?.text === 'string') text = parsed.text; } catch {}
  }
  return {reason: 'accepted', message: {
    app_id: config.app_id, tenant_key: typeof header.tenant_key === 'string' ? header.tenant_key : '',
    event_id: nonempty(header.event_id) ? header.event_id : message.message_id, message_id: message.message_id,
    chat_id: message.chat_id ?? '', chat_type: message.chat_type, message_type: message.message_type ?? '',
    sender_open_id: senderId.open_id ?? null, sender_tenant_key: sender.tenant_key ?? null,
    content, ...(text === undefined ? {} : {text}),
    message_created_ms: String(message.create_time ?? ''), received_at: Date.now() / 1000,
    status: 'received', trust: 'unverified_external_input'
  }};
}
