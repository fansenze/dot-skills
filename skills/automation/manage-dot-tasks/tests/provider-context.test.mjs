import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createConnector} from '../scripts/connectors/feishu.mjs';

test('local adapter retains bounded provider reply context and multiline message text', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-provider-context-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const base = {event_id: 'ev_fixture', message_id: 'om_fixture', app_id: 'app_fixture', tenant_key: 'tenant_fixture',
    sender_tenant_key: 'tenant_fixture', sender_open_id: 'sender_fixture', chat_id: 'chat_fixture', message_type: 'text',
    received_at: 1700000000, message_created_ms: '1700000000000', bot_mention_keys: ['@_bot'], text: '@_bot Do this\n  then this'};
  const context = {parent_id: 'om_parent', root_id: 'om_root', thread_id: 'omt_thread'};
  const invalid = [null, '', ' ', 'bad\nID', 'x'.repeat(257), {}, ['om_array'], 42];
  const messages = [base, {...base, ...context}, ...invalid.map(v => ({...base, parent_id: v, root_id: v, thread_id: v}))]
    .map((message, i) => ({cursor: 'cursor_' + i, message}));
  const server = path.join(dir, 'fixture.mjs');
  fs.writeFileSync(server, `console.log(${JSON.stringify(JSON.stringify({protocol_version: 1, messages, next_cursor: 'cursor_end', has_more: false}))});`);
  const connector = createConnector({server, config_ref: path.join(dir, 'unused'), state_dir: dir, account_id: 'app_fixture', brand: 'feishu'});
  const result = await connector.receive();
  assert.equal(result.next_cursor, 'cursor_end');
  for (const [i, event] of result.events.entries()) {
    assert.equal(event.text, 'Do this\n  then this');
    assert.equal(event.sender_id, 'sender_fixture');
    for (const [key, value] of Object.entries(context)) {
      if (i === 1) assert.equal(event[key], value);
      else assert.equal(Object.hasOwn(event, key), false);
    }
  }
});

test('task reply forwards explicit thread option; old notices retain their original non-thread option',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thread-forward-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const server=path.join(dir,'fixture.mjs');
  fs.writeFileSync(server,`import fs from 'node:fs';const args=process.argv.slice(2);let body='';for await(const c of process.stdin)body+=c;fs.appendFileSync(${JSON.stringify(path.join(dir,'calls.jsonl'))},JSON.stringify({args,body})+'\\n');console.log(JSON.stringify({ok:true,message_id:'outgoing-fixture',idempotency_key:args[args.indexOf('--idempotency-key')+1]}));`);
  const connector=createConnector({server,config_ref:path.join(dir,'unused'),state_dir:dir,account_id:'app-fixture',brand:'feishu'});
  const message={account_id:'app-fixture',destination:{id:'chat-fixture',type:'chat_id'},format:'text',body:'已收到，正在排队处理。',reply_to:'message-fixture',idempotency_key:'stable-fixture'};
  assert.equal((await connector.reply({...message,reply_in_thread:true})).status,'api_accepted');
  await connector.reply({...message,reply_in_thread:true});await connector.reply(message);
  const calls=fs.readFileSync(path.join(dir,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls[0],calls[1]);assert.ok(calls[0].args.includes('--reply-in-thread'));assert.ok(!calls[2].args.includes('--reply-in-thread'));
  assert.equal(calls[0].args[0],'reply');assert.equal(calls[0].args[calls[0].args.indexOf('--message-id')+1],'message-fixture');
});
