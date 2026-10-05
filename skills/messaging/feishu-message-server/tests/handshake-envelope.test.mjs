/** Extraction remains transport-only while preserving evidence needed for setup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Inbox, readInboxPage, extractMessage} from '../scripts/messages.mjs';

const config = {app_id:'app-fixture', brand:'feishu', bot_open_id:'bot-fixture'};
const challenge = 'dot-bind:' + 'b'.repeat(64);
const payload = () => ({schema:'2.0', header:{event_type:'im.message.receive_v1', app_id:'app-fixture', tenant_key:'tenant-fixture', event_id:'event-fixture'},
  event:{sender:{sender_type:'user', tenant_key:'tenant-fixture', sender_id:{open_id:'sender-fixture'}},
    message:{message_id:'message-fixture', chat_id:'chat-fixture', chat_type:'p2p', message_type:'text',
      create_time:'1791190800123', content:JSON.stringify({text:challenge}), mentions:[]}}});

test('server retains native private-chat identity evidence through durable inbox storage and projection', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-handshake-envelope-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const before = Date.now(), result = extractMessage(payload(), config), after = Date.now();
  assert.equal(result.reason, 'accepted'); const message = result.message;
  assert.equal(message.app_id, 'app-fixture'); assert.equal(message.provider_app_id, 'app-fixture');
  assert.equal(message.provider_event_id, 'event-fixture'); assert.equal(message.provider_event_id, message.event_id);
  assert.equal(message.brand, 'feishu'); assert.equal(message.sender_type, 'user'); assert.equal(message.chat_type, 'p2p');
  assert.equal(message.sender_open_id, 'sender-fixture'); assert.equal(message.sender_tenant_key, 'tenant-fixture');
  assert.equal(message.text, challenge); assert.equal(message.message_created_ms, '1791190800123');
  assert.ok(message.received_at * 1000 >= before && message.received_at * 1000 <= after);
  assert.equal(message.status, 'received'); assert.equal(message.trust, 'unverified_external_input');
  const filename = path.join(dir, 'inbox.sqlite'), inbox = new Inbox(filename);
  try { assert.equal(inbox.put(message), true); assert.equal(inbox.put(message), false); } finally { inbox.close(); }
  const page = readInboxPage(filename, {showText:true});
  assert.equal(page.messages.length, 1); const persisted = page.messages[0].message;
  for (const field of ['provider_app_id','provider_event_id','app_id','brand','sender_type','sender_open_id','sender_tenant_key','chat_type','message_created_ms','received_at','text']) {
    assert.equal(persisted[field], message[field]);
  }
});

test('server does not repair missing or mismatched provider app, sender, or timestamp evidence', () => {
  const wrong = payload(); wrong.header.app_id = 'app-other';
  const result = extractMessage(wrong, config);
  assert.equal(result.reason, 'accepted'); assert.equal(result.message.app_id, 'app-fixture'); assert.equal(result.message.provider_app_id, 'app-other');
  const missing = payload(); delete missing.header.app_id; delete missing.header.event_id; delete missing.event.sender.sender_type;
  delete missing.event.sender.tenant_key; delete missing.event.sender.sender_id; delete missing.event.message.create_time;
  const message = extractMessage(missing, config).message;
  assert.equal(message.provider_app_id, null); assert.equal(message.sender_type, null); assert.equal(message.sender_open_id, null);
  assert.equal(message.event_id, 'message-fixture'); assert.equal(message.provider_event_id, null);
  assert.equal(message.sender_tenant_key, null); assert.equal(message.message_created_ms, '');
});

test('post, group mention, and reply messages retain distinguishing evidence instead of becoming native private challenges', () => {
  const post = payload(); post.event.message.message_type = 'post';
  post.event.message.content = JSON.stringify({en_us:{title:'', content:[[{tag:'text', text:challenge}]]}});
  const projected = extractMessage(post, config).message;
  assert.equal(projected.message_type, 'post'); assert.equal(projected.text, challenge); assert.equal(projected.text_source, 'content');
  const group = payload(); group.event.message.chat_type = 'group';
  group.event.message.mentions = [{id:{open_id:'bot-fixture'}, key:'@_bot'}];
  group.event.message.content = JSON.stringify({text:'@_bot '+challenge});
  const mentioned = extractMessage(group, config).message;
  assert.equal(mentioned.chat_type, 'group'); assert.deepEqual(mentioned.bot_mention_keys, ['@_bot']); assert.equal(mentioned.text, '@_bot '+challenge);
  const reply = payload(); Object.assign(reply.event.message, {parent_id:'parent-fixture', root_id:'root-fixture', thread_id:'thread-fixture'});
  const threaded = extractMessage(reply, config).message;
  for (const field of ['parent_id','root_id','thread_id']) assert.equal(threaded[field], reply.event.message[field]);
});
