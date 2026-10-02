import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DEFAULT_STATE, SafeError, ConfigError, loadConfig, initialize, checkConfig, prepareConfig } from './config.mjs';
import { readInbox, readInboxPage } from './messages.mjs';
import { createNetwork, createClient, sendMessage, getHttpDiagnostics } from './transport.mjs';
import { CAPABILITIES } from './formats.mjs';
import { startListener } from './runtime.mjs';

export const HELP = `Feishu Message Server — Node.js 22.18+ (transport only)
Usage: bash feishu.sh <command> [options]
  setup                         Install dependencies from the pnpm lockfile
  init [--stdin-json]            Create private local config; no overwrite
  prepare [--config FILE] [--stdin-json]  Prepare a temporary config
  check                         Check for missing configuration
  start                         Start long connection; Ctrl-C stops it
  inbox [--limit N] [--show-text] Read local messages; text hidden by default
  inbox-page [--cursor TOKEN] [--limit N] [--show-text] Durable ordered inbox page
  capabilities                  Declare supported interface and formats; no credentials needed
  identity                      Report configured app ID and brand only; no network call
  send --receive-id ID --text TEXT [--receive-id-type chat_id]
  reply --message-id ID --text TEXT [--reply-in-thread]
  test | validate | package     Offline tests, skill check, safe portable archive
Options: --config FILE --brand feishu|lark --state-dir DIR
Send/reply text: exactly one of --text, --text-file FILE, --stdin
Optional --format text|markdown|card (card input is JSON); no implicit format fallback.
Optional --idempotency-key KEY for manual retry of the same operation.
Authentication and message HTTP requests each time out after 30 seconds; no automatic send retry.
Retry only when authorized with the same destination, text and key. Changed text needs a new key.
Required config: app_id, app_secret. Default brand: feishu.
Receive private messages and group messages that @this bot. No automatic reply or task execution.
`;

const shared = {config: {type: 'string'}, brand: {type: 'string'}, 'state-dir': {type: 'string'}, help: {type: 'boolean'}};
const outgoing = {text: {type: 'string'}, 'text-file': {type: 'string'}, stdin: {type: 'boolean'}, 'idempotency-key': {type: 'string'}, format: {type: 'string'}, 'expected-app-id': {type: 'string'}, 'expected-brand': {type: 'string'}};
const options = {
  init: {...shared, 'stdin-json': {type: 'boolean'}},
  prepare: {...shared, 'stdin-json': {type: 'boolean'}}, check: shared, start: shared,
  inbox: {...shared, limit: {type: 'string'}, 'show-text': {type: 'boolean'}},
  'inbox-page': {...shared, cursor: {type: 'string'}, limit: {type: 'string'}, 'show-text': {type: 'boolean'}}, capabilities: {help: {type: 'boolean'}}, identity: shared,
  send: {...shared, ...outgoing, 'receive-id': {type: 'string'}, 'receive-id-type': {type: 'string'}},
  reply: {...shared, ...outgoing, 'message-id': {type: 'string'}, 'reply-in-thread': {type: 'boolean'}}
};

async function readStdin(maxBytes) {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxBytes) throw new SafeError('Input exceeds size limit');
    chunks.push(chunk);
  }
  try { return new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)); }
  catch { throw new SafeError('Input must be valid UTF-8'); }
}

async function promptCredentials() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new SafeError('Use an interactive terminal or init --stdin-json');
  let muted = false;
  const output = new Writable({write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback(); }});
  const rl = readline.createInterface({input: process.stdin, output, terminal: true});
  try {
    const appId = await rl.question('app_id: ');
    process.stdout.write('app_secret: '); muted = true;
    const appSecret = await rl.question('');
    muted = false; process.stdout.write('\n');
    return {app_id: appId, app_secret: appSecret};
  } finally { muted = false; rl.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { process.stdout.write(HELP); return 0; }
  if (!Object.hasOwn(options, command)) throw new SafeError('Unknown command; run feishu.sh --help');
  let v;
  try { v = parseArgs({args, options: options[command], strict: true, allowPositionals: false}).values; }
  catch { throw new SafeError('Invalid command options; run feishu.sh --help'); }
  if (v.help) { process.stdout.write(HELP); return 0; }
  const configFile = path.resolve(v.config ?? DEFAULT_CONFIG), stateDir = path.resolve(v['state-dir'] ?? DEFAULT_STATE);
  const print = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (command === 'capabilities') { print(CAPABILITIES); return 0; }
  if (command === 'inbox-page') {
    print(readInboxPage(path.join(stateDir, 'messages.sqlite3'), {cursor: v.cursor ?? null, limit: Number(v.limit ?? 100), showText: Boolean(v['show-text'])})); return 0;
  }
  if (command === 'check') {
    const result = checkConfig(configFile);
    print(result); return result.ok ? 0 : 1;
  }
  if (command === 'prepare') {
    try {
      let values;
      if (v['stdin-json']) {
        try { values = JSON.parse(await readStdin(65536)); }
        catch { throw new ConfigError('invalid_config'); }
      }
      const source = v.config ? configFile : (!v['stdin-json'] && fs.existsSync(DEFAULT_CONFIG) ? DEFAULT_CONFIG : undefined);
      const result = prepareConfig({source, values, brand: v.brand});
      print(result); return result.ok ? 0 : 1;
    } catch (error) {
      print({ok: false, error: error instanceof ConfigError ? error.code : 'prepare_failed'}); return 1;
    }
  }
  if (command === 'init') {
    let data;
    if (v['stdin-json']) {
      try { data = JSON.parse(await readStdin(65536)); }
      catch { throw new SafeError('Invalid stdin JSON; supply app_id and app_secret'); }
    } else data = await promptCredentials();
    initialize(configFile, data?.app_id, data?.app_secret, v.brand ?? data?.brand ?? 'feishu', data?.bot_open_id ?? '');
    print({ok: true, config_initialized: true}); return 0;
  }
  if (command === 'inbox') {
    const limit = Number(v.limit ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new SafeError('limit must be 1..1000');
    print({messages: readInbox(path.join(stateDir, 'messages.sqlite3'), limit, Boolean(v['show-text']))}); return 0;
  }
  const config = loadConfig(configFile, v.brand);
  if (command === 'identity') { print({app_id: config.app_id, brand: config.brand}); return 0; }
  if ((v['expected-app-id'] && config.app_id !== v['expected-app-id']) || (v['expected-brand'] && config.brand !== v['expected-brand'])) {
    print({ok: false, status: 'not_sent', idempotency_key: v['idempotency-key'], request_phase: 'validation', error_code: 'binding-mismatch'}); return 1;
  }
  if (command === 'start') {
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { await startListener(config, {stateDir, signal: controller.signal}); }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return 0;
  }
  if ([v.text !== undefined, v['text-file'] !== undefined, Boolean(v.stdin)].filter(Boolean).length !== 1) {
    throw new SafeError('Provide exactly one of --text, --text-file or --stdin');
  }
  let text = v.text;
  if (v['text-file']) {
    try {
      if (fs.statSync(v['text-file']).size > 80000) throw new Error();
      text = new TextDecoder('utf-8', {fatal: true}).decode(fs.readFileSync(v['text-file']));
    } catch { throw new SafeError('Text file must be readable UTF-8 and within size limit'); }
  }
  if (v.stdin) text = await readStdin(80000);
  if (command === 'reply' && !v['message-id']) throw new SafeError('message-id is required for reply');
  const network = createNetwork();
  try {
    let body = text;
    if (v.format === 'card') { try { body = JSON.parse(text); } catch { throw new SafeError('Card input must be JSON'); } }
    const result = await sendMessage(createClient(config, network), {format: v.format ?? 'text', body, idempotencyKey: v['idempotency-key'],
      receiveId: v['receive-id'], receiveIdType: v['receive-id-type'],
      messageId: v['message-id'], replyInThread: Boolean(v['reply-in-thread'])});
    print(result); return result.ok ? 0 : 1;
  } finally { network.close(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(JSON.stringify({ok: false, error: error instanceof SafeError ? error.message : 'Operation failed; private error details suppressed',
      ...getHttpDiagnostics(error)}) + '\n');
    process.exitCode = 1;
  });
}
