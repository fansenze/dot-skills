/** Real adapter normalization, with a local fixture CLI and no service calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createConnector} from '../scripts/connectors/feishu.mjs';

test('Feishu adapter preserves provider identity and native-text evidence rather than manufacturing it from a projection', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-handshake-envelope-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  const challenge = 'dot-bind:' + 'a'.repeat(64);
  const base = {event_id:'event-fixture', provider_event_id:'event-fixture', message_id:'message-fixture', app_id:'app-fixture', provider_app_id:'app-fixture',
    brand:'feishu', tenant_key:'tenant-fixture', sender_tenant_key:'tenant-fixture', sender_open_id:'sender-fixture',
    sender_type:'user', chat_id:'chat-fixture', chat_type:'p2p', message_type:'text', text:challenge,
    received_at:1700000000.123, message_created_ms:'1700000000123', bot_mention_keys:[]};
  const cases = [
    {name:'native', message:base},
    {name:'post', message:{...base, message_type:'post', text_source:'post'}},
    {name:'mention', message:{...base, text:'@_bot '+challenge, bot_mention_keys:['@_bot']}},
    {name:'missing-evidence', message:{...base, brand:undefined, provider_app_id:undefined, provider_event_id:undefined, sender_type:undefined, chat_type:undefined}},
    {name:'wrong-provider', message:{...base, provider_app_id:'app-other'}},
    {name:'wrong-brand', message:{...base, brand:'lark'}},
    {name:'reply', message:{...base, parent_id:'parent-fixture', root_id:'root-fixture', thread_id:'thread-fixture'}},
    {name:'missing-time', message:{...base, message_created_ms:''}},
    {name:'omitted', message:{...base, text:undefined, text_omitted:true}},
  ];
  const page = {protocol_version:1, next_cursor:'cursor-end', has_more:false,
    messages:cases.map(({message}, i) => ({cursor:'cursor-'+i, message}))};
  const server = path.join(dir, 'fixture-server.mjs');
  fs.writeFileSync(server, `process.stdout.write(${JSON.stringify(JSON.stringify(page))});`);
  const adapter = createConnector({server, config_ref:path.join(dir,'unused'), state_dir:dir, account_id:'app-fixture', brand:'feishu'});
  const {events} = await adapter.receive();
  const byName = Object.fromEntries(events.map((event, i) => [cases[i].name, event]));
  const native = byName.native;
  assert.equal(native.account_id, 'app-fixture'); assert.equal(native.provider_app_id, 'app-fixture');
  assert.equal(native.provider_event_id, 'event-fixture'); assert.equal(native.provider_event_id, native.event_id);
  assert.equal(native.brand, 'feishu'); assert.equal(native.chat_type, 'p2p'); assert.equal(native.sender_type, 'user');
  assert.equal(native.sender_id, 'sender-fixture'); assert.equal(native.sender_tenant_id, 'tenant-fixture');
  assert.equal(native.native_text, challenge); assert.equal(native.text, challenge);
  assert.equal(native.received_at, '2023-11-14T22:13:20.123Z'); assert.equal(native.occurred_at, native.received_at);
  assert.equal(byName.post.text, challenge); assert.equal(Object.hasOwn(byName.post, 'native_text'), false);
  assert.equal(byName.mention.text, challenge); assert.equal(Object.hasOwn(byName.mention, 'native_text'), false);
  for (const field of ['brand','provider_app_id','provider_event_id','sender_type','chat_type']) assert.equal(Object.hasOwn(byName['missing-evidence'], field), false);
  assert.equal(byName['wrong-provider'].provider_app_id, 'app-other'); assert.equal(byName['wrong-provider'].account_id, 'app-fixture');
  assert.equal(byName['wrong-brand'].brand, 'lark');
  for (const field of ['parent_id','root_id','thread_id']) assert.equal(byName.reply[field], field.split('_')[0]+'-fixture');
  assert.equal(byName['missing-time'].occurred_at, null);
  assert.equal(byName.omitted.text_omitted, true); assert.equal(Object.hasOwn(byName.omitted, 'native_text'), false);
});
