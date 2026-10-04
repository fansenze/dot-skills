import {uiTime} from '../presentation.mjs';
/** Calls the actual feishu-message-server CLI, never the platform directly. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConnectorError, renderText, requireText } from './contract.mjs';

// Provider envelope IDs are context hints, never sender identity or authorization.
// Omit malformed optional metadata instead of truncating or inventing identifiers.
const replyContext = message => Object.fromEntries(['parent_id', 'root_id', 'thread_id']
  .filter(key => typeof message[key] === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(message[key]))
  .map(key => [key, message[key]]));

export function createConnector(settings) {
  const fields = ['server', 'config_ref', 'state_dir', 'account_id', 'brand'];
  if (!settings || Object.keys(settings).some(k => !fields.includes(k))) throw new ConnectorError('Feishu settings accept only server/config_ref/state_dir paths, account_id and brand');
  for (const key of fields.slice(0, 3)) if (!path.isAbsolute(requireText(settings[key], key, 2048))) throw new ConnectorError('Feishu settings paths must be absolute');
  requireText(settings.account_id, 'account ID');
  if (!['feishu', 'lark'].includes(settings.brand)) throw new ConnectorError('Explicit Feishu/Lark brand required');
  if (!fs.statSync(settings.server).isFile()) throw new ConnectorError('Feishu server entry point is unavailable');
  async function invoke(args, body, signal) {
    const env = {...process.env}; delete env.DEBUG; delete env.NODE_DEBUG;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', settings.server, ...args], {stdio: ['pipe', 'pipe', 'pipe'], env, signal});
      const timer = setTimeout(() => child.kill('SIGKILL'), args[0] === 'send' || args[0] === 'reply' ? 74000 : 14000);
      let stdout = '', size = 0;
      child.stdout.on('data', data => { size += data.length; if (size > 4 * 1024 * 1024) child.kill('SIGKILL'); else stdout += data; });
      // Do not copy raw stderr, CLI exceptions, credentials or message bodies into diagnostics.
      child.stderr.resume(); child.on('error', () => reject(new ConnectorError('Feishu CLI unavailable')));
      child.stdin.on('error', () => {});
      child.on('close', () => { clearTimeout(timer); try { if (size > 4 * 1024 * 1024) throw new Error(); resolve(JSON.parse(stdout)); } catch { reject(new ConnectorError('Feishu CLI returned no complete result')); } });
      child.stdin.end(body);
    });
  }
  const render = (format, doc) => {
    if (format === 'text' || format === 'markdown') return renderText(doc, format === 'markdown');
    if (format !== 'card') throw new ConnectorError('Unsupported format');
    const plain = text => ({tag: 'div', text: {tag: 'plain_text', content: String(text)}});
    const row = cells => ({tag: 'column_set', flex_mode: 'none', columns: cells.map((value, i) => ({
      tag: 'column', width: 'weighted', weight: i === 2 ? 3 : 2, elements: [plain(value)]}))});
    return {config: {wide_screen_mode: true}, header: {title: {tag: 'plain_text', content: doc.title+' · '+uiTime(doc.updated_at)}},
      elements: [...(doc.columns.length && doc.rows.length ? [row(doc.columns)] : []),
        ...doc.rows.map(row), ...doc.details.map(plain)]};
  };
  async function send(message, signal, reply = false) {
    if (message.account_id !== settings.account_id) return {status: 'not_sent', idempotency_key: message.idempotency_key, retryable: false, error_code: 'binding-mismatch'};
    const args = [reply ? 'reply' : 'send', '--config', settings.config_ref, '--expected-app-id', settings.account_id, '--expected-brand', settings.brand,
      '--format', message.format, '--stdin', '--idempotency-key', message.idempotency_key];
    if (reply) {
      args.push('--message-id', requireText(message.reply_to, 'reply target'));
      if (message.reply_in_thread === true) args.push('--reply-in-thread');
    }
    else args.push('--receive-id', requireText(message.destination.id, 'destination'), '--receive-id-type', message.destination.type);
    const result = await invoke(args, typeof message.body === 'string' ? message.body : JSON.stringify(message.body), signal);
    return {...result, status: result.ok === true && result.message_id ? 'api_accepted' : result.status,
      retryable: result.status === 'not_sent' && ['ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET'].includes(result.error_code)};
  }
  return {
    capabilities: () => invoke(['capabilities']), render,
    send: (message, {signal} = {}) => send(message, signal),
    reply: (message, {signal} = {}) => send(message, signal, true),
    async receive({cursor, limit = 100, signal} = {}) {
      const args = ['inbox-page', '--state-dir', settings.state_dir, '--limit', String(limit), '--show-text'];
      if (cursor !== null && cursor !== undefined) args.push('--cursor', cursor);
      const page = await invoke(args, undefined, signal);
      if (page.protocol_version !== 1 || !Array.isArray(page.messages)) throw new ConnectorError('Feishu inbox protocol unavailable');
      return {next_cursor: page.next_cursor, has_more: page.has_more, events: page.messages.map(({cursor, message: m}) => {
        let text = m.text;
        for (const key of m.bot_mention_keys ?? []) if (typeof text === 'string') text = text.replace(key, '').trim();
        return {cursor, ...replyContext(m), event_id: m.event_id, message_id: m.message_id, account_id: m.app_id, tenant_id: m.tenant_key,
          sender_tenant_id: m.sender_tenant_key, sender_id: m.sender_open_id, destination_id: m.chat_id,
          type: m.message_type, ...(m.text_source ? {text_source:m.text_source} : {}), ...(m.text_omitted ? {text_omitted:true} : {}), received_at: new Date(m.received_at * 1000).toISOString(),
          occurred_at: /^\d{13}$/.test(m.message_created_ms) ? new Date(Number(m.message_created_ms)).toISOString() : null, text};
      })};
    }
  };
}
