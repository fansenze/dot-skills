import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {createConnector} from '../scripts/connectors/feishu.mjs';
import * as m from '../scripts/taskctl.mjs';
const MODULE=fileURLToPath(new URL('./fixtures/attachment-connector.mjs',import.meta.url));
async function fixture(t,create=false) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'task-attachments-')),root=path.join(tmp,'store'),external=path.join(tmp,'provider');fs.mkdirSync(external);t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  const settings=path.join(tmp,'settings.json');fs.writeFileSync(settings,JSON.stringify({root:external,account_id:'account-one',brand:'feishu'}));
  const call=(...argv)=>m.run(m.parse_args(['--store',root,...argv.map(String)]));
  await call('init');await call('connect','--id','fixture-one','--module',MODULE,'--settings-file',settings);
  await call('allow-inbound','--id','grant-one','--connector','fixture-one','--account','account-one','--all-senders','--mode','agent','--commands','query,create,continue','--tasks','all','--allow-new','--updates','--format','card','--reply-mode','reply','--since','2000-01-01T00:00:00Z');
  const envelope={event_id:'event-one',message_id:'om_source',account_id:'account-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',text:'Prepare the report',received_at:new Date().toISOString()};
  fs.writeFileSync(path.join(external,'inbox.json'),JSON.stringify([envelope]));await call('ingest','--connector','fixture-one');
  const claim=(await call('message-next','--consumer','dot-fixture')).messages[0],decision=path.join(tmp,'decision.json');
  fs.writeFileSync(decision,JSON.stringify(create?{decision:'create',title:'Internal task title',goal:'Deliver report',next_action:'Prepare report',authorization_ref:'synthetic-request',summary:'Prepare report',reply:'Preparing the report.'}:{decision:'query',summary:'Report ready',response:{template:'detail',lead:'The report is ready.\n\nIt covers the requested period.',links:[{label:'Source notes',url:'https://example.com/notes'}]}}));
  await call('message-record',claim.id,'--token',claim.token,'--decision-file',decision);
  await call('deliver','--consumer','sender');
  const file=path.join(external,'report.pdf');fs.writeFileSync(file,'%PDF-1.7\nsynthetic');
  const upload=(id='report-upload',kind='file')=>call('attachment-upload','--id',id,'--connector','fixture-one','--path',file,'--allowed-root',external,'--kind',kind,'--authorization-ref','synthetic-file-authorization');
  const reply=(id='report-reply',resource='report-upload')=>call('attachment-reply','--id',id,'--resource-id',resource,'--inbound-id',claim.id,'--authorization-ref','synthetic-disclosure-authorization');
  const state=()=>JSON.parse(fs.readFileSync(path.join(root,'integration.json')));
  const effects=()=>fs.readFileSync(path.join(external,'effects.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  return {tmp,root,external,call,claim,file,upload,reply,state,effects,envelope};
}
test('upload and source-bound threaded send persist separately with fixed keys and actual message IDs',async t=>{
  const f=await fixture(t),before=f.effects().length;
  const [a,b]=await Promise.all([f.upload(),f.upload()]);assert.equal(a.id,b.id);assert.equal(fs.readFileSync(path.join(f.external,'uploads.jsonl'),'utf8').trim().split('\n').length,1);
  const uploaded=await f.call('attachment-status','--id','report-upload');assert.equal(uploaded.state,'uploaded');assert.equal(f.effects().length,before);assert.equal(uploaded.receipt.resource.app_id,'account-one');
  const notice=await f.reply();assert.deepEqual(await f.reply(),notice);assert.equal(notice.state,'pending');assert.ok(notice.id.length<=50);assert.notEqual(notice.id,uploaded.key);
  await f.call('deliver','--consumer','sender');const sent=f.effects().at(-1);
  assert.deepEqual(sent.body,{resource_id:uploaded.key});assert.equal(sent.format,'file');assert.equal(sent.reply_to,'om_source');assert.equal(sent.reply_in_thread,true);assert.equal(sent.destination.id,'chat-one');assert.ok(Buffer.byteLength(JSON.stringify(sent))<1000);
  const n=f.state().outbox.find(n=>n.id===notice.id);assert.equal(n.state,'api_accepted');assert.ok(n.receipt.message_id);assert.equal(n.attachment.resource.sha256,uploaded.descriptor.sha256);
  fs.unlinkSync(f.file);assert.deepEqual(await f.upload(),uploaded);await f.call('deliver','--consumer','recovery');assert.equal(f.effects().length,before+1);
  assert.equal((await f.call('doctor')).ok,true);
  const ordinary=f.effects()[1].body;assert.equal(ordinary.header,undefined);assert.equal(ordinary.elements[0].text.content,'The report is ready.\n\nIt covers the requested period.');assert.doesNotMatch(JSON.stringify(ordinary),/Task response|任务回复|"button"/);
});
test('unknown upload reconciles by read-only receipt lookup without a new upload or automatic send',async t=>{
  const f=await fixture(t);fs.writeFileSync(path.join(f.external,'unknown-upload'),'yes');
  assert.equal((await f.upload()).state,'upload_unknown');assert.equal((await f.upload()).state,'upload_unknown');await assert.rejects(f.reply(),/uploaded resource/);
  const restored=await f.call('attachment-reconcile','--id','report-upload');assert.equal(restored.state,'uploaded');assert.equal(fs.readFileSync(path.join(f.external,'uploads.jsonl'),'utf8').trim().split('\n').length,1);
  const data=f.state();data.uploads[0].state='uploading';data.uploads[0].receipt=null;fs.writeFileSync(path.join(f.root,'integration.json'),JSON.stringify(data));
  assert.equal((await f.call('attachment-reconcile','--id','report-upload')).state,'uploaded');assert.doesNotMatch(JSON.stringify(f.state()),/PRIVATE/);
});
test('uncertain send is protected across restarts, changed IDs conflict, revoked routes cannot send',async t=>{
  const f=await fixture(t);await f.upload();const n=await f.reply();fs.writeFileSync(path.join(f.external,'mode'),'throw-after-effect');
  await f.call('deliver','--consumer','sender');assert.equal(f.state().outbox.find(x=>x.id===n.id).state,'delivery_unknown');const count=f.effects().length;
  await f.call('deliver','--consumer','restarted');assert.equal(f.effects().length,count);await assert.rejects(f.call('retry-notice',n.id,'--reason','retry'),/reconcile/);
  await f.upload('other-upload');await assert.rejects(f.reply('report-reply','other-upload'),/conflicts/);
  await f.call('deny-inbound','grant-one');await assert.rejects(f.reply('new-reply'),/binding/);assert.equal(f.effects().length,count);
});
test('canonical conversation recognizes replies to accepted attachments in the original source topic',async t=>{
  const f=await fixture(t,true),entry=f.state().inbox.find(r=>r.id===f.claim.id),binding=path.join(f.tmp,'binding.json');
  fs.writeFileSync(binding,JSON.stringify({authorization_ref:'synthetic-two-channel',verification_ref:entry.id,dot:{conversation_id:'dot-one',sender_id:'owner-one',root_id:'dot-root'},feishu:{grant_id:'grant-one',root_id:'om_source'},channels:['feishu']}));
  await f.call('conversation-bind',entry.task_id,'--file',binding);await f.upload();const n=await f.reply();await f.call('deliver','--consumer','sender');const receipt=f.state().outbox.find(x=>x.id===n.id).receipt;
  await f.call('schedule',entry.task_id,'--event-id','synthetic-report-event','--request-id','synthetic-report-request','--source',f.claim.source,'--source-ref',f.claim.source_ref,'--action','execute','--authorization-ref','synthetic-request','--work-revision','1');
  await f.call('message-ack',entry.id,'--token',f.claim.token);
  const incoming={...f.envelope,event_id:'event-two',message_id:'om_followup',parent_id:receipt.message_id,text:'Please revise page two',received_at:new Date().toISOString()};
  fs.writeFileSync(path.join(f.external,'inbox.json'),JSON.stringify([f.envelope,incoming]));await f.call('ingest','--connector','fixture-one');
  const claims=(await f.call('message-next','--consumer','dot-fixture','--limit','10')).messages;
  const followup=claims.find(c=>c.envelope.message_id==='om_followup');assert.equal(followup.context.task_conversation.matches[0]?.task_id,entry.task_id);
  const inputFile=path.join(f.tmp,'followup.json');fs.writeFileSync(inputFile,JSON.stringify({id:'attachment-followup',channel:'feishu',provider_message_id:'om_followup',identity:{account_id:'account-one',tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one'},occurred_at:incoming.received_at,in_reply_to:receipt.message_id,text:incoming.text,privacy:'reviewed',audience:'shared',evidence_ref:followup.id}));
  assert.equal((await f.call('conversation-input',entry.task_id,'--file',inputFile)).outcome,'appended');
});

const feishuRoot=process.env.FEISHU_SKILL_PATH??fileURLToPath(new URL('../../../messaging/feishu-message-server/',import.meta.url));
test('direct Feishu adapter enforces reviewed roots and passes real upload/reply CLI metadata through loopback', {skip:!fs.existsSync(path.join(feishuRoot,'scripts/server.mjs'))},async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'direct-attachment-')),state=path.join(tmp,'receiver'),directory=path.join(state,'resident'),file=path.join(tmp,'report.pdf'),config=path.join(tmp,'synthetic.json');
  let service,network;t.after(async()=>{await service?.close();network?.close();fs.rmSync(tmp,{recursive:true,force:true});});
  const module=name=>import(pathToFileURL(path.join(feishuRoot,'scripts',name+'.mjs')).href);
  const {startResident,runtimeIdentity}=await module('resident'),{createNetwork,createClient,uploadResource}=await module('transport'),{fromMapping}=await module('config'),{sendResidentMessage}=await module('server');
  fs.writeFileSync(file,'%PDF-1.7\nsynthetic');const values={app_id:'cli_direct_fixture',app_secret:'synthetic-secret'};fs.writeFileSync(config,JSON.stringify(values));
  network=createNetwork();const requests=[];network.httpInstance.defaults.adapter=async req=>{
    requests.push(req);return {data:req.url.includes('tenant_access_token')?{code:0,tenant_access_token:'synthetic-token',expire:7200}:{code:0,data:req.url.endsWith('/files')?{file_key:'file_direct'}:{message_id:'om_direct'}},status:200,statusText:'OK',headers:{},config:req};
  };
  const identity={app_id:values.app_id,brand:'feishu',runtime:runtimeIdentity()},client=createClient(fromMapping(values),network);
  service=await startResident({directory,identity,handler:(op,args)=>op==='upload'?uploadResource(client,args,identity):sendResidentMessage(client,args,directory,identity)});
  const settings={server:path.join(feishuRoot,'scripts/server.mjs'),config_ref:config,state_dir:state,account_id:values.app_id,brand:'feishu',attachment_roots:[tmp]},adapter=createConnector(settings);
  assert.equal((await adapter.capabilities()).upload,true);assert.equal((await createConnector({...settings,attachment_roots:[]}).capabilities()).upload,false);
  assert.throws(()=>adapter.inspectUpload({filePath:file,allowedRoot:path.dirname(tmp),kind:'file'}),/outside/);
  const descriptor=await adapter.inspectUpload({filePath:file,allowedRoot:tmp,kind:'file'});
  const uploaded=await adapter.upload({account_id:values.app_id,descriptor,idempotency_key:'direct-upload'});assert.equal(uploaded.status,'uploaded');assert.equal(uploaded.resource.file_key,'file_direct');
  assert.deepEqual(await adapter.uploadStatus({account_id:values.app_id,idempotency_key:'direct-upload'}),uploaded);
  const result=await adapter.reply({account_id:values.app_id,destination:{id:'chat-one',type:'chat_id'},format:'file',body:{resource_id:'direct-upload'},reply_to:'om_original',reply_in_thread:true,idempotency_key:'direct-message'});
  assert.equal(result.status,'api_accepted');assert.equal(result.message_id,'om_direct');const wire=JSON.parse(requests.at(-1).data);assert.equal(wire.reply_in_thread,true);assert.equal(wire.content,'{"file_key":"file_direct"}');
  assert.throws(()=>adapter.upload({account_id:'wrong-account',descriptor,idempotency_key:'wrong'}),/account mismatch/);
});
