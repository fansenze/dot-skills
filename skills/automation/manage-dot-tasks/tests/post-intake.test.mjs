/** Real receiver -> durable inbox -> CLI -> adapter -> agent intake; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as m from '../scripts/taskctl.mjs';
import {digest} from '../scripts/connectors/contract.mjs';

test('post content survives real CLI intake, restart, scoped decisions and legacy rejection dedup',async t=>{
  const companion=process.env.FEISHU_SKILL_PATH??fileURLToPath(new URL('../../../messaging/feishu-message-server',import.meta.url));
  if(!fs.existsSync(path.join(companion,'node_modules/@larksuiteoapi/node-sdk'))) return t.skip('Set FEISHU_SKILL_PATH to the installed companion for receiver integration');
  const {Inbox,extractMessage}=await import(pathToFileURL(path.join(companion,'scripts/messages.mjs')).href);
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'post-intake-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const root=path.join(tmp,'store'),receiver=path.join(tmp,'receiver');fs.mkdirSync(receiver);
  const settings=path.join(tmp,'settings.json');fs.writeFileSync(settings,JSON.stringify({server:path.join(companion,'scripts/server.mjs'),config_ref:path.join(tmp,'unused-config'),state_dir:receiver,account_id:'app-fixture',brand:'feishu'}));
  const call=(...args)=>m.run(m.parse_args(['--store',root,...args]));
  await call('init');await call('connect','--id','feishu-fixture','--module',fileURLToPath(new URL('../scripts/connectors/feishu.mjs',import.meta.url)),'--settings-file',settings);
  await call('allow-inbound','--id','grant-fixture','--connector','feishu-fixture','--account','app-fixture','--tenant','tenant-fixture','--sender','sender-fixture','--destination','chat-fixture','--mode','agent','--commands','query,create,continue','--tasks','none','--allow-new','--updates','--since','2026-01-01T00:00:00Z');
  const payload=n=>({header:{event_type:'im.message.receive_v1',event_id:'event-'+n,tenant_key:'tenant-fixture'},event:{sender:{sender_id:{open_id:'sender-fixture'},tenant_key:'tenant-fixture'},message:{message_id:'message-'+n,chat_id:'chat-fixture',chat_type:'p2p',message_type:'post',create_time:String(Date.now()),parent_id:'parent-fixture',content:JSON.stringify({post:{zh_cn:{title:'虚构/演示',content:[[{tag:'text',text:'整理演示资料 '},{tag:'a',text:'引用',href:'https://example.com/reference'}]]}}}),content_v2:JSON.stringify({content:[[{tag:'md',text:'请整理演示资料\n$(inert text)'}],[{tag:'a',text:'引用',href:'https://example.com/reference'}]]})}}});
  const inbox=new Inbox(path.join(receiver,'messages.sqlite3'));
  for(const n of [1,2,3,4,5,6]) {
    const p=payload(n);
    if(n===2)p.event.sender.sender_id.open_id='other-sender';
    if(n===3)p.event.message.create_time='1000000000000';
    if(n===4)p.event.message.message_type='interactive';
    if(n===6){p.event.message.content='invalid';p.event.message.content_v2='invalid';}
    const row=extractMessage(p,{app_id:'app-fixture'}).message;
    // Also exercise compatible old receiver rows, with raw post but no projection.
    delete row.text;delete row.text_source;inbox.put(row);
  }
  inbox.close();
  const store=new m.Store(root),state=()=>JSON.parse(fs.readFileSync(store.path('integration.json'),'utf8'));
  await store.locked(()=>{const data=state();data.inbox.push({id:digest(['feishu-fixture','app-fixture','tenant-fixture','message-5']),event_key:digest(['feishu-fixture','app-fixture','tenant-fixture','event-5']),connector:'feishu-fixture',status:'rejected',reason:'legacy-non-text'});store.commit({'integration.json':m.encoded(data)});});
  assert.equal((await call('ingest','--connector','feishu-fixture')).ingested,6);
  assert.equal((await call('ingest','--connector','feishu-fixture')).ingested,0);
  assert.equal(state().inbox.filter(r=>r.mode==='agent').length,1);assert.equal(state().outbox.length,3);
  assert.equal(state().inbox.filter(r=>r.failure).length,2);assert.ok(state().inbox.find(r=>r.failure).failure.reason);
  assert.match(await call('render','list','--language','zh'),/未创建的请求/);
  const claim=(await call('message-next','--consumer','reviewer')).messages[0];
  assert.equal(claim.envelope.type,'post');assert.equal(claim.envelope.text_source,'content_v2');
  assert.equal(claim.envelope.text,'请整理演示资料\n$(inert text)\n引用 (https://example.com/reference)');
  assert.equal(claim.envelope.sender_id,'sender-fixture');assert.equal(claim.envelope.parent_id,'parent-fixture');
  assert.deepEqual(await call('queue'),[]);assert.deepEqual(await call('list','--all'),[]);
  const decision={decision:'create',summary:'虚构/演示请求已核对',reply:'将整理演示资料。',title:'虚构/演示任务',goal:'核对演示结果',next_action:'检查虚构输入',authorization_ref:'synthetic-user-authorization'};
  const file=path.join(tmp,'decision.json');fs.writeFileSync(file,JSON.stringify(decision));
  const created=await call('message-record',claim.id,'--token',claim.token,'--decision-file',file);
  await store.locked(()=>{const data=state();data.inbox.find(r=>r.id===claim.id).lease.until='2000-01-01T00:00:00Z';store.commit({'integration.json':m.encoded(data)});});
  const recovered=(await call('message-next','--consumer','restarted')).messages[0];
  assert.equal(recovered.mode,'ack');assert.equal(recovered.task_id,created.task_id);assert.equal(recovered.envelope.type,'post');
  await call('message-record',recovered.id,'--token',recovered.token,'--decision-file',file);await call('message-ack',recovered.id,'--token',recovered.token);
  assert.equal((await call('list','--all')).length,1);assert.equal(state().outbox.length,4);
  assert.ok(state().outbox.every(n=>n.reply_in_thread===true));assert.equal((await call('doctor')).ok,true);
});
