/** Real bounded waits with isolated stores and synthetic, offline transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as core from '../scripts/taskctl.mjs';
import {createIntegration} from '../scripts/integration.mjs';
import {create_scheduler} from '../scripts/scheduler.mjs';
import {readConversations} from '../scripts/task-conversations.mjs';

const CONNECTOR=fileURLToPath(new URL('./fixtures/conversation-connector.mjs',import.meta.url));
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
async function fixture(t, states=['delivery_unknown']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'continuous-intake-')),storeRoot=path.join(root,'store');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let serial=0;
  const file=value=>{const target=path.join(root,`input-${++serial}.json`);fs.writeFileSync(target,core.encoded(value));return target;};
  const call=(...args)=>core.run(core.parse_args(['--store',storeRoot,...args.map(String)]));
  const incoming=id=>({event_id:'event-'+id,message_id:id,account_id:'account-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',text:'Inspect the authorized task.',root_id:'original-topic',received_at:new Date().toISOString()});
  const inbox=[incoming('association')];
  const writeInbox=()=>fs.writeFileSync(path.join(root,'inbox.json'),core.encoded(inbox));
  await call('init');
  await call('register','--id','task-one','--title','Synthetic task','--goal','Verified outcome','--status','executing');
  await call('connect','--id','fixture','--module',CONNECTOR,'--settings-file',file({root}));
  await call('allow-inbound','--id','grant-one','--connector','fixture','--account','account-one','--tenant','tenant-one','--sender','sender-one','--destination','chat-one','--mode','agent','--commands','query,continue','--tasks','task-one','--since','2000-01-01T00:00:00Z');
  writeInbox();await call('ingest','--connector','fixture');
  const [entry]=(await call('message-next','--consumer','setup')).messages;
  await call('message-record',entry.id,'--token',entry.token,'--decision-file',file({decision:'query',task_id:'task-one',summary:'Synthetic association',reply:'Association recorded.'}));
  await call('message-ack',entry.id,'--token',entry.token);await call('deliver','--consumer','setup');
  await call('conversation-bind','task-one','--file',file({authorization_ref:'synthetic-authorization',verification_ref:entry.id,dot:{conversation_id:'dot-one',sender_id:'owner-one',root_id:'dot-root'},feishu:{grant_id:'grant-one',root_id:'original-topic'},channels:['feishu']}));
  for(let i=0;i<states.length;i++)await call('conversation-publish','task-one','--file',file({id:'canonical-'+i,kind:'text',text:'Synthetic prior reply.',format:'text',privacy:'reviewed',audience:'shared'}));
  const store=new core.Store(storeRoot),scheduler=create_scheduler({...core,store});
  // Synthetic fault injection under the real lock; no provider call is made.
  const edit=fn=>store.locked(()=>{const data=readConversations(store);fn(data);store.commit({'conversations.json':core.encoded(data)});});
  await edit(data=>data.deliveries.forEach((n,i)=>{
    n.state=states[i];n.attempts=1;
    n.receipt=n.state==='sending'?null:{status:n.state,idempotency_key:n.id,retryable:false};
    n.lease=n.state==='sending'?{consumer:'interrupted',token:'expired-token',until:'2000-01-01T00:00:00Z'}:null;
  }));
  const waits=[];
  let afterWait=null;
  const integration=createIntegration({store,makeTask:core.make_task,scheduler:{...scheduler,wait:async args=>{
    waits.push(args.timeout_ms);
    const result=await scheduler.wait(args);
    if(afterWait){const fn=afterWait;afterWait=null;await fn();}
    return result;
  }}});
  const start=timeout_ms=>integration.run({command:'start',consumer:'active-dot',timeout_ms});
  const state=()=>json(path.join(storeRoot,'conversations.json'));
  const bytes=()=>fs.readFileSync(path.join(storeRoot,'conversations.json'),'utf8');
  const effects=()=>fs.readFileSync(path.join(root,'effects.jsonl'),'utf8');
  return {call,edit,waits,start,state,bytes,effects,afterWait:fn=>{afterWait=fn;},incoming:id=>{inbox.push(incoming(id));writeInbox();}};
}

test('unchanged conversation issues allow two full idle waits without changing or resending them',async t=>{
  const f=await fixture(t,['delivery_unknown','not_sent','api_error']),before=f.bytes(),effects=f.effects();
  for(let cycle=0;cycle<2;cycle++){
    f.waits.length=0;
    const started=performance.now(),result=await f.start(1400),elapsed=performance.now()-started;
    assert.ok(elapsed>=1380,`idle cycle ${cycle} returned after ${elapsed} ms`);
    assert.ok(elapsed<5000,`idle cycle ${cycle} exceeded its bounded wait: ${elapsed} ms`);
    assert.ok(f.waits[0]>0);
    assert.ok(f.waits.every(ms=>ms>=0&&ms<=1400));
    assert.equal(result.timed_out,true);assert.deepEqual(result.batch,[]);assert.deepEqual(result.messages,[]);
    assert.deepEqual(result.notifications,[]);assert.deepEqual(result.receive_gaps,[]);
    assert.equal(result.conversation_issues.total,3);
    assert.deepEqual(result.conversation_issues.deliveries.map(n=>n.state),['delivery_unknown','not_sent','api_error']);
    assert.equal(f.bytes(),before);assert.equal(f.effects(),effects);
  }
  f.waits.length=0;await f.start(0);assert.deepEqual(f.waits,[0]);
  for(const timeout of [-1,60001,0.5,NaN])await assert.rejects(f.start(timeout),/timeout-ms must be 0\.\.60000/);
  assert.equal(f.bytes(),before);assert.equal(f.effects(),effects);
});

test('an expired sending intent becomes a new unknown issue and returns without an idle wait',async t=>{
  const f=await fixture(t,['delivery_unknown','sending']),[old,sending]=f.state().deliveries,effects=f.effects();
  const result=await f.start(60000);
  assert.deepEqual(f.waits,[0]);assert.equal(result.conversation_issues.total,2);
  assert.equal(result.conversation_issues.deliveries[1].id,sending.id);
  const [unchanged,recovered]=f.state().deliveries;
  assert.deepEqual(unchanged,old);assert.equal(recovered.state,'delivery_unknown');assert.equal(recovered.lease,null);
  assert.equal(recovered.attempts,sending.attempts);assert.equal(recovered.receipt.error_code,'sender-interrupted');
  assert.equal(recovered.receipt.retryable,false);assert.equal(recovered.receipt.idempotency_key,sending.id);
  assert.deepEqual(result.notifications,[]);assert.equal(f.effects(),effects);
});

test('new or changed issues beyond the first twenty are detected independently of the display limit',async t=>{
  for(const [before,after] of [['not_sent','api_error'],['api_accepted','delivery_unknown']]){
    const f=await fixture(t,[...Array(20).fill('delivery_unknown'),before]),initial=f.state(),effects=f.effects();
    f.afterWait(()=>f.edit(data=>{const n=data.deliveries[20];n.state=after;n.receipt={status:after,idempotency_key:n.id,retryable:false};}));
    const result=await f.start(60000);
    assert.deepEqual(f.waits,[5000,0]);assert.equal(result.conversation_issues.total,21);
    assert.equal(result.conversation_issues.deliveries.length,20);
    assert.ok(result.conversation_issues.deliveries.every(n=>n.state==='delivery_unknown'));
    assert.deepEqual(f.state().deliveries.slice(0,20),initial.deliveries.slice(0,20));
    assert.equal(f.state().deliveries[20].state,after);assert.equal(f.effects(),effects);
  }
});

test('an authorized message arriving during an idle wait is claimed promptly despite an old unknown',async t=>{
  const f=await fixture(t),before=f.bytes(),effects=f.effects();
  f.afterWait(()=>f.incoming('new-request'));
  const result=await f.start(60000);
  assert.deepEqual(f.waits,[5000,0]);assert.equal(result.ingested,1);assert.equal(result.messages.length,1);
  const [message]=result.messages;
  assert.equal(message.mode,'interpret');assert.equal(message.envelope.message_id,'new-request');
  assert.equal(message.grant.id,'grant-one');assert.equal(message.source,'connector-fixture');assert.equal(message.source_ref,message.id);
  assert.deepEqual(result.batch,[]);assert.deepEqual(result.receive_gaps,[]);
  assert.equal(result.conversation_issues.total,1);assert.equal(f.bytes(),before);assert.equal(f.effects(),effects);
  assert.deepEqual(await f.call('queue'),[]);
});
