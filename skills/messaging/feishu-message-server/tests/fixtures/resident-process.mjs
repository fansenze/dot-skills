// Synthetic test-only process. Never reads a real configuration or contacts a provider other than loopback.
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { startResident, residentRequest, runtimeIdentity } from '../../scripts/resident.mjs';

const [mode, directory, provider, operation = 'health', encoded = '{}'] = process.argv.slice(2);
const identity = {app_id: 'cli_resident_fixture_only', brand: 'feishu', runtime: runtimeIdentity()};
const args = JSON.parse(encoded);
const began = performance.now();

async function syntheticTransport() {
  const url = new URL(provider);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Fixture requires explicit loopback provider');
  const {createNetwork, createClient, sendText} = await import('../../scripts/transport.mjs');
  const network = createNetwork();
  const client = createClient({...identity, app_secret: 'synthetic-not-a-real-service-secret', domain: provider}, network);
  return {network, send: (op, input) => sendText(client, op === 'reply' ? {...input, messageId: input.messageId ?? 'om_fixture_parent'} : input)};
}

try {
  if (mode === 'resident') {
    const {network, send} = await syntheticTransport();
    const {Inbox, readInbox, readInboxPage} = await import('../../scripts/messages.mjs');
    const {createDispatcher} = await import('../../scripts/transport.mjs');
    const inboxFile = path.join(directory, 'synthetic-inbox.sqlite');
    const inbox = new Inbox(inboxFile);
    if (args.seedReceive) {
      const dispatcher = createDispatcher({...identity, bot_open_id: 'ou_synthetic_bot'}, inbox);
      const event = {schema: '2.0', header: {event_type: 'im.message.receive_v1', app_id: identity.app_id,
        tenant_key: 'synthetic_tenant', event_id: 'synthetic_event'}, event: {
        sender: {sender_type: 'user', sender_id: {open_id: 'ou_synthetic_sender'}},
        message: {message_id: 'om_fixture_parent', chat_id: 'oc_synthetic_fixture', chat_type: 'p2p',
          message_type: 'text', content: JSON.stringify({text: 'Synthetic received message'}), mentions: []}
      }};
      await dispatcher.invoke(event, {needCheck: false});
      await dispatcher.invoke(event, {needCheck: false});
    }
    const cancellation = new AbortController();
    const resident = await startResident({directory, identity, signal: cancellation.signal, handler: async (op, input) => {
      if (op === 'send' || op === 'reply') return send(op, input);
      if (op === 'identity') return {ok: true, identity};
      if (op === 'capabilities') return {ok: true, operations: ['health', 'identity', 'capabilities', 'inbox', 'inbox-page', 'send', 'reply']};
      if (op === 'inbox') return {ok: true, messages: readInbox(inboxFile, input.limit ?? 20, input.showText ?? false)};
      if (op === 'inbox-page') return {ok: true, ...readInboxPage(inboxFile, input)};
      return {ok: true, status: 'ready', identity};
    }});
    const stop = () => { network.close(); cancellation.abort(); inbox.close(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
    console.log(JSON.stringify({ready: true, port: resident.port, identity}));
  } else if (mode === 'request') {
    const result = await residentRequest({directory, identity: args._identity ?? identity, operation, args: args._args ?? args, timeout: 3000});
    console.log(JSON.stringify({result, elapsed_ms: performance.now() - began}));
  } else if (mode === 'direct') {
    const {network, send} = await syntheticTransport();
    try {
      const result = await send(operation, args);
      console.log(JSON.stringify({result, elapsed_ms: performance.now() - began}));
    } finally { network.close(); }
  } else throw new Error('Unknown fixture mode');
} catch (error) {
  console.log(JSON.stringify({error: error.message, elapsed_ms: performance.now() - began}));
  process.exitCode = 1;
}
