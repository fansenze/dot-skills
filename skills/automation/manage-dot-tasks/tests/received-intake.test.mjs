import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as m from '../scripts/taskctl.mjs';

const cli = fileURLToPath(new URL('../scripts/taskctl.mjs', import.meta.url));
const adapter = fileURLToPath(new URL('./fixtures/connector.mjs', import.meta.url));
const options = fields => Object.entries(fields).flatMap(([key,value]) => value === undefined || value === false ? [] :
  value === true ? ['--'+key.replaceAll('_','-')] : ['--'+key.replaceAll('_','-'),String(value)]);

async function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'received-intake-')), root = path.join(tmp,'store'), external = path.join(tmp,'transport');
  fs.mkdirSync(external); t.after(() => fs.rmSync(tmp,{recursive:true,force:true}));
  const settings = path.join(tmp,'settings.json');
  fs.writeFileSync(settings,JSON.stringify({root:external,account_id:'account-one',brand:'feishu'}));
  const call = (...args) => m.run(m.parse_args(['--store',root,...args]));
  await call('init'); await call('connect','--id','feishu-main','--module',adapter,'--settings-file',settings);
  const policy = (fields={}) => call('allow-inbound',...options({id:'received-tasks',connector:'feishu-main',account:'account-one',all_senders:true,mode:'agent',commands:'query,create,continue',tasks:'none',allow_new:true,updates:true,...fields}));
  const state = () => JSON.parse(fs.readFileSync(path.join(root,'integration.json'),'utf8'));
  const rows = [], append = (...events) => { rows.push(...events); fs.writeFileSync(path.join(external,'inbox.json'),JSON.stringify(rows)); };
  const ingest = (...events) => { append(...events); return call('ingest','--connector','feishu-main'); };
  const incoming = (n=1,fields={}) => {
    const at = new Date().toISOString();
    return {event_id:'event-'+n,provider_event_id:'event-'+n,message_id:'message-'+n,account_id:'account-one',provider_app_id:'account-one',brand:'feishu',
      tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',chat_type:'p2p',sender_type:'user',
      type:'text',text:'Prepare the release checklist.',received_at:at,occurred_at:at,...fields};
  };
  const record = (claim,decision) => {
    const file = path.join(tmp,'decision.json'); fs.writeFileSync(file,JSON.stringify(decision));
    return call('message-record',claim.id,'--token',claim.token,'--decision-file',file);
  };
  const next = () => call('message-next','--consumer','test-agent','--limit','20');
  return {tmp,root,external,call,policy,state,append,ingest,incoming,record,next};
}

test('first real task enters the normal workflow and records its trigger without a handshake',async t => {
  const f = await fixture(t), policy = await f.policy();
  assert.equal(policy.all_senders,true); assert.equal(policy.sender,undefined);
  assert.deepEqual(f.state().handshakes,[]); assert.deepEqual(f.state().outbox,[]);
  const event = f.incoming(); f.append(event);
  const result = await f.call('start','--consumer','active-agent','--timeout-ms','0'), [claim] = result.messages;
  assert.equal(claim.envelope.text,event.text); assert.equal(claim.grant.sender,event.sender_id);
  assert.equal(claim.acknowledgement.state,'api_accepted'); assert.equal(claim.grant.id,policy.id);
  assert.equal(claim.grant.since,policy.since); assert.deepEqual(claim.context.tasks,[]);
  assert.deepEqual(await f.call('list','--all'),[]); assert.deepEqual(await f.call('queue'),[]);
  const recorded = await f.record(claim,{decision:'create',summary:'Prepare release checklist',reply:'I will prepare it.',
    title:'Release checklist',goal:'Deliver the reviewed checklist',next_action:'Inspect release notes',authorization_ref:claim.id});
  const outcome = (await f.call('inbound')).outcomes[0];
  assert.equal(outcome.task_id,recorded.task_id);
  assert.deepEqual(outcome.trigger,{account_id:'account-one',brand:'feishu',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',
    destination_id:'chat-one',chat_type:'p2p',sender_type:'user',provider_app_id:'account-one',provider_event_id:'event-1',event_id:'event-1',message_id:'message-1',
    cursor:'1',occurred_at:event.occurred_at,received_at:event.received_at});
  assert.equal(outcome.trigger.text,undefined);
  assert.equal((await f.call('lookup','--source',claim.source,'--source-ref',claim.source_ref)).task_id,recorded.task_id);
  const task = await f.call('update',recorded.task_id,'--status','executing','--reason','Begin requested work');
  await f.call('schedule',task.id,'--event-id','received-work','--request-id','received-request','--source',claim.source,'--source-ref',claim.source_ref,
    '--action','execute','--authorization-ref',claim.id,'--work-revision',String(task.work_revision));
  await f.call('message-ack',claim.id,'--token',claim.token);
  const [scheduled] = (await f.call('next-batch','--consumer','worker')).batch;
  assert.equal(scheduled.spec.task_id,task.id);
  await f.call('doctor');
});

test('restart reuses the intake policy, cutoff and message history; duplicate events do not add work',async t => {
  const f = await fixture(t), policy = await f.policy(), e = f.incoming(); await f.ingest(e);
  const [claim] = (await f.next()).messages;
  await f.record(claim,{decision:'clarify',summary:'Clarify checklist scope',reply:'Which release?'});
  await f.call('message-ack',claim.id,'--token',claim.token);
  f.append(e,f.incoming(2,{text:'Use the October release.'}));
  const restarted = spawnSync(process.execPath,[cli,'--store',f.root,'ingest','--connector','feishu-main'],{encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr);
  const again = await f.policy(); assert.equal(again.since,policy.since);
  const [follow] = (await f.next()).messages;
  assert.equal(follow.grant.id,claim.grant.id); assert.equal(follow.context.messages[0].id,claim.id);
  assert.equal(f.state().grants.length,1); assert.equal(f.state().inbox.length,2); assert.deepEqual(f.state().handshakes,[]);
});

test('each received sender/chat is recorded separately, including group and rich-text tasks',async t => {
  const f = await fixture(t); await f.policy();
  await f.ingest(f.incoming(1),f.incoming(2,{sender_id:'sender-two',text:'I am sender-one.'}),
    f.incoming(3,{destination_id:'group-one',chat_type:'group',type:'post',text_source:'post',parent_id:'parent-one',root_id:'root-one',thread_id:'thread-one'}));
  const claims = (await f.next()).messages; assert.equal(claims.length,3);
  assert.equal(new Set(claims.map(c=>c.grant.id)).size,1);
  assert.equal(claims[1].grant.sender,'sender-two'); assert.equal(claims[2].envelope.thread_id,'thread-one');
  for (const claim of claims) assert.deepEqual(claim.context.messages,[]);
  assert.equal(f.state().grants.length,1); assert.equal(f.state().grants[0].sender,undefined);
});

test('all-senders intake has no sender whitelist, including previously denied identities',async t => {
  const f = await fixture(t);
  await f.call('allow-inbound',...options({id:'fixed-user',connector:'feishu-main',account:'account-one',tenant:'tenant-one',sender:'sender-one',destination:'chat-one',
    mode:'agent',commands:'query',tasks:'none',since:'2000-01-01T00:00:00Z'}));
  await f.call('deny-inbound','fixed-user'); await f.policy();
  await f.ingest(f.incoming(1),f.incoming(2,{sender_id:'sender-two',tenant_id:'tenant-two',sender_tenant_id:'tenant-two',destination_id:'chat-two'}));
  assert.ok(f.state().inbox.every(r=>r.grant_id==='received-tasks'&&r.status==='pending'));
  assert.equal(f.state().grants.length,2); assert.equal(f.state().grants[0].enabled,false);
  assert.equal((await f.next()).messages.length,2);
});

test('disabling the intake policy stops new work and queued replies',async t => {
  const f = await fixture(t); await f.policy(); await f.ingest(f.incoming());
  const [claim] = (await f.next()).messages;
  await f.call('deny-inbound','received-tasks');
  await assert.rejects(f.record(claim,{decision:'query',summary:'Query',reply:'Result'}),/disabled/);
  await f.call('deliver','--consumer','sender'); assert.equal(f.state().outbox[0].state,'cancelled');
  assert.equal(fs.existsSync(path.join(f.external,'effects.jsonl')),false);
  assert.equal((await f.ingest(f.incoming(2))).ingested,0);
  const restarted = spawnSync(process.execPath,[cli,'--store',f.root,'start','--consumer','restarted','--timeout-ms','0'],{encoding:'utf8'});
  assert.equal(restarted.status,0,restarted.stderr); assert.equal(f.state().grants[0].enabled,false);
});

test('sender metadata is recorded without an identity gate; only app and cutoff select the stream',async t => {
  const f = await fixture(t); await f.policy();
  await f.ingest(f.incoming(1,{sender_id:'new-user',provider_app_id:undefined,provider_event_id:undefined,sender_type:undefined}),
    f.incoming(2,{sender_id:'another-user',tenant_id:'another-tenant',sender_tenant_id:'sender-tenant',destination_id:'another-chat'}),
    f.incoming(3,{account_id:'another-app'}),f.incoming(4,{occurred_at:'2000-01-01T00:00:00Z'}));
  assert.deepEqual(f.state().inbox.map(r=>r.status),['pending','pending','rejected','rejected']);
  assert.equal(f.state().grants.length,1); assert.equal((await f.next()).messages.length,2);
});

test('first task in the registration second survives receiver timestamp rounding, without replaying earlier tasks',async t => {
  const f = await fixture(t), now = Date.now(), since = new Date(now).toISOString();
  await f.policy({since});
  const received = new Date(Math.floor(now/1000)*1000).toISOString();
  await f.ingest(f.incoming(1,{received_at:received,occurred_at:new Date(now-1).toISOString()}),
    f.incoming(2,{received_at:received,occurred_at:since}),f.incoming(3,{received_at:received,occurred_at:since}));
  assert.deepEqual(f.state().inbox.map(r=>r.status),['rejected','pending','pending']);
  assert.equal(f.state().grants.length,1);
});

test('selecting all-senders intake cancels obsolete setup and treats every message as ordinary input',async t => {
  const f = await fixture(t);
  const h = await f.call('handshake-begin',...options({id:'old-setup',connector:'feishu-main',account:'account-one',brand:'feishu',authorization_ref:'old-request',
    grant_id:'old-user',commands:'query,create,continue',allow_new:true,tasks:'none'}));
  await f.policy(); assert.equal((await f.call('handshake-status',h.id)).state,'cancelled');
  await f.ingest(f.incoming(1,{text:h.challenge,native_text:h.challenge}),f.incoming(2));
  assert.ok(f.state().inbox.every(r=>r.reason==='awaiting-agent'));
  assert.equal((await f.next()).messages[0].envelope.message_id,'message-1');
});

test('all-senders configuration needs no identity fields and retains one immutable intake policy',async t => {
  const f = await fixture(t);
  for (const fields of [{mode:'commands'},{sender:'sender-one'},{tenant:'tenant-one'},{destination:'chat-one'},
    {context_from:'old-grant'},{account:'other'},{allow_new:false},{commands:'query'},{tasks:undefined}]) await assert.rejects(f.policy(fields));
  await f.policy();
  await assert.rejects(f.policy({id:'another-policy'}),/existing/);
  await assert.rejects(f.policy({tasks:'all'}),/immutable/);
  assert.equal(f.state().grants.length,1);
});

test('unsupported content records the triggering identity and failure without creating a task',async t => {
  const f = await fixture(t); await f.policy(); await f.ingest(f.incoming(1,{type:'image',text:undefined}));
  const [outcome] = (await f.call('inbound')).outcomes;
  assert.equal(outcome.status,'failed'); assert.equal(outcome.trigger.sender_id,'sender-one');
  assert.equal(outcome.task_id,null); assert.equal((await f.next()).messages.length,0);
  assert.deepEqual(await f.call('list','--all'),[]);
});

test('shared intake keeps each sender task context and completion destination separate',async t => {
  const f = await fixture(t); await f.policy();
  await f.ingest(f.incoming(1),f.incoming(2,{sender_id:'sender-two',destination_id:'chat-two'}));
  const claims = (await f.next()).messages, tasks = [];
  for (const claim of claims) {
    const r = await f.record(claim,{decision:'create',summary:'Prepare checklist',reply:'I will prepare it.',title:'Checklist',
      goal:'Deliver the checklist',next_action:'Review notes',authorization_ref:claim.id});
    tasks.push(r.task_id); await f.call('message-ack',claim.id,'--token',claim.token);
  }
  await f.ingest(f.incoming(3),f.incoming(4,{sender_id:'sender-two',destination_id:'chat-two'}));
  const follow = (await f.next()).messages;
  assert.deepEqual(follow[0].context.tasks.map(t=>t.id),[tasks[0]]);
  assert.deepEqual(follow[1].context.tasks.map(t=>t.id),[tasks[1]]);
  for (const id of tasks) {
    await f.call('update',id,'--status','executing','--reason','Prepare checklist');
    await f.call('update',id,'--status','awaiting_verification','--reason','Ready to review');
    await f.call('check',id,'--name','complete','--outcome','pass','--evidence','Synthetic checklist verified');
    await f.call('complete',id,'--summary','Checklist ready','--evidence','Synthetic outcome');
  }
  const notices = f.state().outbox.filter(n=>n.event_id.startsWith('task:'));
  assert.equal(notices.length,2);
  for (let i=0;i<2;i++) {
    assert.equal(notices[i].route.destination.id,claims[i].envelope.destination_id);
    assert.equal(notices[i].reply_to,claims[i].envelope.message_id);
  }
  await f.call('deliver','--consumer','sender');
  assert.ok(f.state().outbox.every(n=>n.state==='api_accepted'));
  assert.equal(f.state().grants.length,1); await f.call('doctor');
});

test('queued reply routes cannot be redirected to another received chat',async t => {
  const f = await fixture(t); await f.policy();
  await f.ingest(f.incoming(1),f.incoming(2,{sender_id:'sender-two',destination_id:'chat-two'}));
  const state = f.state(); state.outbox[0].route.destination.id='chat-two';
  const store = new m.Store(f.root);
  await store.locked(()=>store.commit({'integration.json':m.encoded(state)}));
  await assert.rejects(f.call('deliver','--consumer','sender'),/route integrity/);
  assert.equal(fs.existsSync(path.join(f.external,'effects.jsonl')),false);
});

test('reply references in a shared chat retain the actual originating sender',async t=>{
  const f=await fixture(t);await f.policy();
  await f.ingest(f.incoming(1),f.incoming(2,{sender_id:'sender-two'}));
  for(const claim of (await f.next()).messages){
    await f.record(claim,{decision:'query',summary:'Request reviewed',reply:'No tasks yet.'});
    await f.call('message-ack',claim.id,'--token',claim.token);
  }
  await f.call('deliver','--consumer','sender');
  await f.ingest(f.incoming(3),f.incoming(4,{sender_id:'sender-two'}));
  const claims=(await f.next()).messages;
  assert.equal(claims.length,2);
  for(let i=0;i<2;i++){
    assert.equal(claims[i].context.reply_references.length,2);
    assert.ok(claims[i].context.reply_references.every(r=>r.in_reply_to==='message-'+(i+1)));
    assert.equal(claims[i].context.messages.length,1);
    assert.equal(claims[i].context.messages[0].envelope.sender_id,claims[i].envelope.sender_id);
  }
});
