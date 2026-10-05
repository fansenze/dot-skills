import {extractReadableContent} from './content.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { object, privateDirectory, SafeError } from './config.mjs';

export class Inbox {
  constructor(filename) {
    privateDirectory(path.dirname(filename));
    const fd = fs.openSync(filename, 'a', 0o600);
    fs.closeSync(fd);
    fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS messages (
        app_id TEXT NOT NULL, tenant_key TEXT NOT NULL,
        event_id TEXT NOT NULL, message_id TEXT NOT NULL,
        message_json TEXT NOT NULL,
        PRIMARY KEY(app_id, tenant_key, message_id),
        UNIQUE(app_id, tenant_key, event_id))`);
    this.db.exec('CREATE TABLE IF NOT EXISTS inbox_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO inbox_metadata VALUES (?,?)').run('stream_id', randomUUID());
      const max = this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get().n;
      this.db.prepare('INSERT OR IGNORE INTO inbox_metadata VALUES (?,?)').run('sequence', String(max));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    this.insert = this.db.prepare('INSERT OR IGNORE INTO messages(rowid,app_id,tenant_key,event_id,message_id,message_json) VALUES (?,?,?,?,?,?)');
  }
  put(m) {
    // Sequence and message commit together before SDK ACK. Never reuse a deleted
    // row's cursor; duplicates allocate no sequence and create no gaps.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sequence = Number(this.db.prepare("SELECT value FROM inbox_metadata WHERE key='sequence'").get().value) + 1;
      if (!Number.isSafeInteger(sequence) || sequence < 1) throw new SafeError('Invalid inbox sequence');
      const inserted = this.insert.run(sequence, m.app_id, m.tenant_key, m.event_id, m.message_id, JSON.stringify(m)).changes === 1;
      if (!inserted && !this.db.prepare('SELECT 1 FROM messages WHERE app_id=? AND tenant_key=? AND (message_id=? OR event_id=?)').get(m.app_id, m.tenant_key, m.message_id, m.event_id)) throw new SafeError('Inbox sequence conflicts with an incompatible writer');
      if (inserted) this.db.prepare("UPDATE inbox_metadata SET value=? WHERE key='sequence'").run(String(sequence));
      this.db.exec('COMMIT'); return inserted;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

const encodeCursor = (stream, offset) => Buffer.from(JSON.stringify({stream, offset})).toString('base64url');
export function readInboxPage(filename, {cursor = null, limit = 100, showText = false} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SafeError('limit must be 1..1000');
  // Missing/unmigrated stores cannot masquerade as an empty healthy stream.
  if (!fs.existsSync(filename)) throw new SafeError('Inbox unavailable; start the authorized receiver first');
  const db = new DatabaseSync(filename, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    const stream = db.prepare("SELECT value FROM inbox_metadata WHERE key='stream_id'").get()?.value;
    if (!stream) throw new SafeError('Inbox cursor metadata unavailable; use the current receiver');
    let offset = 0;
    if (cursor !== null) {
      let c; try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch {}
      if (!c || c.stream !== stream || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new SafeError('Inbox cursor does not match this stream');
      offset = c.offset;
    }
    const max = Number(db.prepare("SELECT value FROM inbox_metadata WHERE key='sequence'").get()?.value);
    const storedMax = db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get().n;
    if (!Number.isSafeInteger(max) || max < 0 || offset > max || storedMax !== max) throw new SafeError('Inbox cursor gap: store was truncated or written by an incompatible receiver');
    const rows = db.prepare('SELECT rowid, message_json FROM messages WHERE rowid > ? ORDER BY rowid LIMIT ?').all(offset, limit);
    const messages = rows.map((row, index) => {
      if (row.rowid !== offset + index + 1) throw new SafeError('Inbox cursor gap: retained messages are incomplete');
      const message = JSON.parse(row.message_json);
      if (showText) Object.assign(message, extractReadableContent(message));
      else { delete message.text; delete message.content; delete message.content_v2; }
      return {cursor: encodeCursor(stream, row.rowid), message};
    });
    const end = rows.at(-1)?.rowid ?? offset;
    return {protocol_version: 1, messages, next_cursor: encodeCursor(stream, end), has_more: end < max};
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError('Inbox cursor read failed; preserve the checkpoint and inspect receiver storage');
  } finally { db.close(); }
}

export function readInbox(filename, limit = 20, showText = false) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be 1..1000');
  if (!fs.existsSync(filename)) return [];
  const db = new DatabaseSync(filename, {readOnly: true, timeout: 750});
  try {
    return db.prepare('SELECT message_json FROM messages ORDER BY rowid DESC LIMIT ?').all(limit)
      .map(({message_json}) => {
        const message = JSON.parse(message_json);
        if (showText) Object.assign(message, extractReadableContent(message));
      else { delete message.text; delete message.content; delete message.content_v2; }
        return message;
      });
  } finally { db.close(); }
}

const nonempty = s => typeof s === 'string' && s.length > 0;

// Provider envelope IDs are context hints, never sender identity or authorization.
// Omit malformed optional metadata instead of truncating or inventing identifiers.
const replyContext = message => Object.fromEntries(['parent_id', 'root_id', 'thread_id']
  .filter(key => typeof message[key] === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(message[key]))
  .map(key => [key, message[key]]));

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
  const contentV2 = message.content_v2 === undefined ? {} : {content_v2: typeof message.content_v2 === 'string' ? message.content_v2 : JSON.stringify(message.content_v2)};
  return {reason: 'accepted', message: {
    app_id: config.app_id, provider_app_id: header.app_id ?? null, provider_event_id: header.event_id ?? null, brand: config.brand, sender_type: sender.sender_type ?? null, tenant_key: typeof header.tenant_key === 'string' ? header.tenant_key : '',
    event_id: nonempty(header.event_id) ? header.event_id : message.message_id, message_id: message.message_id,
    chat_id: message.chat_id ?? '', chat_type: message.chat_type, message_type: message.message_type ?? '',
    sender_open_id: senderId.open_id ?? null, sender_tenant_key: sender.tenant_key ?? null,
    bot_mention_keys: (Array.isArray(message.mentions) ? message.mentions : []).filter(m => config.bot_open_id && object(object(m).id).open_id === config.bot_open_id)
      .map(m => m.key).filter(k => typeof k === 'string' && k.startsWith('@')),
    ...replyContext(message), content, ...contentV2, ...extractReadableContent({...message, content, ...contentV2}),
    message_created_ms: String(message.create_time ?? ''), received_at: Date.now() / 1000,
    status: 'received', trust: 'unverified_external_input'
  }};
}
