import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as cli from '../scripts/taskctl.mjs';
import {sendResult} from '../scripts/connectors/contract.mjs';
import {renderConnectorDocument, renderResponse, responseDocument} from '../scripts/reply-presentation.mjs';
import {taskNotificationDocument, taskResponseDocument} from '../scripts/presentation.mjs';

async function fixture(t, channel = 'feishu') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-routing-')), transport=path.join(root,'transport'), store=path.join(root,'store');
  fs.mkdirSync(transport); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const settings=path.join(root,'settings.json');fs.writeFileSync(settings,JSON.stringify({root:transport,presentation:channel,react:channel==='feishu'}));
  const call=(...args)=>cli.run(cli.parse_args(['--store',store,...args]));
  await call('init');await call('connect','--id','channel-main','--module',fileURLToPath(new URL('./fixtures/connector.mjs',import.meta.url)),'--settings-file',settings);
  await call('allow-inbound','--id','receipt-policy','--connector','channel-main','--account','account-one','--all-senders','--mode','agent','--commands','query,create,continue','--tasks','all','--allow-new','--updates');
  const rows=[];
  const event=(id,fields={})=>({event_id:'event-'+id,message_id:id,account_id:'account-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',text:'A synthetic request',received_at:new Date().toISOString(),...fields});
  const ingest=async(...messages)=>{rows.push(...messages);fs.writeFileSync(path.join(transport,'inbox.json'),JSON.stringify(rows));return call('ingest','--connector','channel-main');};
  const state=()=>JSON.parse(fs.readFileSync(path.join(store,'integration.json')));
  const deliver=()=>call('deliver','--consumer','test-agent','--limit','100');
  return {root,transport,store,call,event,ingest,state,deliver};
}

test('Feishu acknowledges the first topic message with text and subsequent messages with Get, including batched/restarted intake',async t=>{
  const f=await fixture(t),first=f.event('om_first');
  await f.ingest(first,f.event('om_second',{root_id:'om_first',thread_id:'omt_topic'}),f.event('om_third',{thread_id:'omt_topic'}));
  assert.deepEqual(f.state().outbox.map(n=>n.operation??'message'),['message','react','react']);
  const sent=await f.deliver();assert.ok(sent.notifications.every(n=>n.state==='api_accepted'));
  const calls=fs.readFileSync(path.join(f.transport,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls[0].format,'text');assert.equal(calls[0].body,'收到，正在处理。');
  assert.deepEqual(calls.slice(1).map(m=>[m.message_id,m.emoji_type]),[['om_second','Get'],['om_third','Get']]);
  assert.ok(calls.slice(1).every(m=>m.body===undefined&&m.destination===undefined));
  await f.ingest(first,f.event('om_fourth',{parent_id:'om_third'}));await f.deliver();await f.deliver();
  assert.equal(f.state().outbox.length,4);assert.equal(fs.readFileSync(path.join(f.transport,'calls.jsonl'),'utf8').trim().split('\n').length,4);
  const claim=(await f.call('message-next','--consumer','test-agent')).messages[0];
  assert.ok(claim.context.reply_references.every(r=>r.message_id!=='reaction-fixture'));
});

test('topic roots and accepted bot replies are scoped to chat, tenant, account and binding; new roots stay first messages',async t=>{
  const f=await fixture(t);await f.ingest(f.event('om_original'));await f.deliver();
  await f.ingest(f.event('om_reply',{parent_id:'provider-message-id'}),f.event('om_new'),
    f.event('om_other_chat',{root_id:'om_original',destination_id:'chat-two'}),f.event('om_other_tenant',{root_id:'om_original',tenant_id:'tenant-two'}),
    f.event('om_other_sender',{root_id:'om_original',sender_id:'sender-two'}));
  assert.deepEqual(f.state().outbox.map(n=>n.operation??'message'),['message','react','message','message','message','react']);
  assert.equal(f.state().outbox[1].reaction.message_id,'om_reply');
});

test('other connectors retain their existing acknowledgement behavior within a topic',async t=>{
  const f=await fixture(t,'default');await f.ingest(f.event('om_first'),f.event('om_second',{root_id:'om_first'}));
  assert.equal(f.state().grants[0].format,'markdown');
  assert.ok(f.state().outbox.every(n=>!n.operation));await f.deliver();
  assert.ok(f.state().outbox.every(n=>n.wire_body==='收到，正在处理。'));
  const message=(await f.call('message-next','--consumer','test-agent')).messages[0],file=path.join(f.root,'decision.json');
  fs.writeFileSync(file,JSON.stringify({decision:'query',summary:'Reviewed synthetic query',response:{template:'detail',title:'任务进展',lead:'资料已核对。'}}));
  await f.call('message-record',message.id,'--token',message.token,'--decision-file',file);await f.deliver();
  assert.equal(f.state().outbox.at(-1).wire_format,'markdown');assert.equal(f.state().outbox.at(-1).wire_body,'# 任务进展\n\n资料已核对。');
});

test('uncertain reactions preserve their frozen payload and never fall back to another message or automatic retry',async t=>{
  const f=await fixture(t);await f.ingest(f.event('om_first'));await f.deliver();
  fs.writeFileSync(path.join(f.transport,'mode'),'throw-after-effect');await f.ingest(f.event('om_second',{root_id:'om_first'}));
  const [result]=(await f.deliver()).notifications;assert.equal(result.state,'delivery_unknown');
  const n=f.state().outbox[1];assert.deepEqual(n.wire_body,{message_id:'om_second',emoji_type:'Get'});assert.equal(n.wire_format,undefined);
  assert.equal((await f.deliver()).notifications.length,0);assert.equal(f.state().outbox.length,2);
  await assert.rejects(f.call('resolve-notice',n.id,'--status','api_accepted','--message-id','wrong','--evidence','Synthetic receipt'),/reaction_id/);
  await f.call('resolve-notice',n.id,'--status','api_accepted','--reaction-id','reaction-verified','--evidence','Synthetic reaction receipt');
  assert.equal(f.state().outbox[1].receipt.reaction_id,'reaction-verified');
  assert.equal(sendResult({status:'api_accepted',idempotency_key:'key',message_id:'wrong'},'key','react').status,'delivery_unknown');
});

test('disabled authority and forged reaction targets cannot dispatch',async t=>{
  const f=await fixture(t);await f.ingest(f.event('om_first'),f.event('om_second',{root_id:'om_first'}));
  const data=f.state();data.outbox[1].reaction.message_id='om_unrelated';fs.writeFileSync(path.join(f.store,'integration.json'),JSON.stringify(data));
  await assert.rejects(f.deliver(),/receipt reaction/);
  data.outbox[1].reaction.message_id='om_second';fs.writeFileSync(path.join(f.store,'integration.json'),JSON.stringify(data));
  await f.call('deny-inbound','receipt-policy');await f.deliver();assert.ok(f.state().outbox.every(n=>n.state==='cancelled'));
  assert.equal(fs.existsSync(path.join(f.transport,'calls.jsonl')),false);
});

test('direct and bridge Feishu channels use one renderer; completion notices omit internal checks while detail keeps them',async t=>{
  const f=await fixture(t);let task=await f.call('register','--title','Hourly report','--goal','Report a verified quote');
  await f.call('update',task.id,'--status','executing','--reason','Configure requested schedule');
  await f.call('update',task.id,'--status','awaiting_verification','--reason','Verify schedule');
  await f.call('check',task.id,'--name','Hourly automation configured','--outcome','pass','--evidence','enabled=true FREQ=HOURLY');
  task=await f.call('complete',task.id,'--summary','Scheduled hourly; first report at 15:27.','--evidence','Verified requested schedule');
  const notification=taskNotificationDocument(task),detail=taskResponseDocument([task]);
  assert.doesNotMatch(JSON.stringify(notification.response),/FREQ=|任务目标|验收检查/);
  assert.match(JSON.stringify(detail.response),/FREQ=HOURLY/);
  for(const name of ['feishu-message-server','remote-config-bridge']) {
    const result=renderConnectorDocument({name,presentation:'feishu'},'card',notification);
    assert.deepEqual(result,renderResponse(notification.response,'card'));
    assert.equal(result.header.text_tag_list[0].color,'green');
  }
  const response={template:'detail',lead:'Done',sections:[{title:'Verified',items:['✓ A check']},{title:'Next',items:['A next step']}]};
  const card=renderResponse(response,'card');assert.doesNotMatch(JSON.stringify(card),/• ✓|heading/);
  assert.ok(card.elements.filter(e=>e.tag==='column_set').every(e=>e.columns[0].elements[0].text.text_size==='notation'));
  const doc=responseDocument(response);assert.equal(renderConnectorDocument({},'markdown',doc),renderResponse(response));
});
