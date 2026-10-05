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
import { startListener, createLog } from './runtime.mjs';
import { startResident, residentRequest, runtimeIdentity } from './resident.mjs';
import { randomUUID } from 'node:crypto';

export const HELP = `Feishu Message Server — Node.js 22.18+ (transport only)
Usage: bash feishu.sh <command> [options]
  setup                         Install dependencies from the pnpm lockfile
  init [--stdin-json]            Create private local config; no overwrite
  prepare [--config FILE] [--stdin-json]  Prepare a temporary config
  check                         Check for missing configuration
  start                         Start/reuse local resident; Ctrl-C stops owner
  health                        Read matching resident health
  inbox [--limit N] [--show-text] Read local messages; text hidden by default
  inbox-page [--cursor TOKEN] [--limit N] [--show-text] Durable ordered inbox page
  capabilities                  Declare supported interface and formats; no credentials needed
  identity                      Report configured app ID and brand only; no network call
  send --receive-id ID --text TEXT [--receive-id-type chat_id]
  reply --message-id ID --text TEXT [--reply-in-thread]
  test | validate | package     Offline tests, skill check, safe portable archive
Options: --config FILE --brand feishu|lark --state-dir DIR
Resident: --resident-dir DIR (trusted local service; no separate access token)
--standalone explicitly uses legacy direct CLI; never automatic fallback.
--isolated start requires explicit separate resident-dir and state-dir.
Send/reply text: exactly one of --text, --text-file FILE, --stdin
Optional --format text|markdown|card (card input is JSON); no implicit format fallback.
Optional --idempotency-key KEY for manual retry of the same operation.
Authentication and message HTTP requests each time out after 30 seconds; no automatic send retry.
Retry only when authorized with the same destination, text and key. Changed text needs a new key.
Required config: app_id, app_secret. Default brand: feishu.
Receive private messages and group messages that @this bot. No automatic reply or task execution.
`;

const shared = {'resident-dir': {type: 'string'}, standalone: {type: 'boolean'}, isolated: {type: 'boolean'}, config: {type: 'string'}, brand: {type: 'string'}, 'state-dir': {type: 'string'}, help: {type: 'boolean'}};
const outgoing = {text: {type: 'string'}, 'text-file': {type: 'string'}, stdin: {type: 'boolean'}, 'idempotency-key': {type: 'string'}, format: {type: 'string'}, 'expected-app-id': {type: 'string'}, 'expected-brand': {type: 'string'}};
const options = {
  init: {...shared, 'stdin-json': {type: 'boolean'}},
  prepare: {...shared, 'stdin-json': {type: 'boolean'}}, check: shared, start: shared, health: shared,
  inbox: {...shared, limit: {type: 'string'}, 'show-text': {type: 'boolean'}},
  'inbox-page': {...shared, cursor: {type: 'string'}, limit: {type: 'string'}, 'show-text': {type: 'boolean'}}, capabilities: shared, identity: shared,
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
  const residentDir = path.resolve(v['resident-dir'] ?? path.join(stateDir, 'resident'));
  if (v.isolated && (command !== 'start' || !v['resident-dir'] || !v['state-dir'])) throw new SafeError('isolated requires start with explicit resident-dir and state-dir');
  if (v.standalone && (v['resident-dir'] || v.isolated)) throw new SafeError('standalone cannot be mixed with resident options');
  const remoteRead = v['resident-dir'] && ['identity','capabilities','inbox','inbox-page','health'].includes(command);
  if (remoteRead || command === 'health') {
    const config = loadConfig(configFile, v.brand);
    const result = await residentRequest({directory: residentDir, identity: {app_id: config.app_id, brand: config.brand, runtime: runtimeIdentity()}, operation: command, args: {cursor: v.cursor, limit: Number(v.limit ?? 100), showText: Boolean(v['show-text'])}});
    print(result); return result.ok === false ? 1 : 0;
  }
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
    let service, network;
    try {
      if (v.standalone) { await startListener(config, {stateDir, signal: controller.signal}); return 0; }
      const identity = {app_id: config.app_id, brand: config.brand, runtime: runtimeIdentity()};
      if (fs.existsSync(path.join(residentDir, 'endpoint.json'))) {
        const health = await residentRequest({directory: residentDir, identity, operation: 'health'});
        if (!health.ok || !health.receiver_connected || health.state_dir !== stateDir) throw new SafeError('Existing resident is not matching and healthy; no fallback');
        print({...health, reused: true}); return 0;
      }
      network = createNetwork({signal: controller.signal});
      const client = createClient(config, network);
      let connected = false;
      service = await startResident({directory: residentDir, identity, signal: controller.signal,
        handler: async (operation, args) => {
          if (operation === 'health') return {ok: true, receiver_connected: connected, state_dir: stateDir, identity};
          if (operation === 'identity') return {app_id: config.app_id, brand: config.brand};
          if (operation === 'capabilities') return CAPABILITIES;
          if (operation === 'inbox-page') return readInboxPage(path.join(stateDir, 'messages.sqlite3'), args);
          if (operation === 'inbox') return {messages: readInbox(path.join(stateDir, 'messages.sqlite3'), args.limit ?? 20, Boolean(args.showText))};
          if ((operation === 'reply') !== (args.messageId !== undefined)) throw new SafeError('operation-target-mismatch');
          return sendMessage(client, args);
        }});
      const log = createLog(stateDir);
      await startListener(config, {stateDir, signal: controller.signal,
        networkFactory: () => ({...network, close() {}}), clientFactory: () => client,
        log: (event, details) => {
          if (['transport_connected','transport_reconnected'].includes(event)) connected = true;
          if (['transport_reconnecting','transport_failed','listener_stopped'].includes(event)) connected = false;
          log(event, details);
        }});
    } finally {
      controller.abort(); await service?.close(); network?.close();
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
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
  let body = text;
  if (v.format === 'card') { try { body = JSON.parse(text); } catch { throw new SafeError('Card input must be JSON'); } }
  const outgoingArgs = {format: v.format ?? 'text', body, idempotencyKey: v['idempotency-key'] ?? randomUUID(),
    receiveId: v['receive-id'], receiveIdType: v['receive-id-type'], messageId: v['message-id'], replyInThread: Boolean(v['reply-in-thread'])};
  if (!v.standalone) {
    try {
      const result = await residentRequest({directory: residentDir, identity: {app_id: config.app_id, brand: config.brand, runtime: runtimeIdentity()}, operation: command, args: outgoingArgs});
      print(result); return result.ok ? 0 : 1;
    } catch (error) {
      print({ok: false, status: ['resident-unavailable-no-fallback','resident-binding-mismatch','unsafe-local-permissions','resident-request-rejected','resident-binding-or-operation-mismatch','invalid-arguments','idempotency-key-required','idempotency-conflict'].includes(error.code) ? 'not_sent' : 'delivery_unknown',
        idempotency_key: outgoingArgs.idempotencyKey, error_code: error instanceof SafeError ? error.message : 'resident-request-failed'}); return 1;
    }
  }
  const network = createNetwork();
  try {
    const result = await sendMessage(createClient(config, network), outgoingArgs);
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
