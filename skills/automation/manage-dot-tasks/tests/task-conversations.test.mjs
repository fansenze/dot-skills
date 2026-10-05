/** Real CLI subprocess tests using isolated stores and synthetic, offline transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const SCRIPT=fileURLToPath(new URL('../scripts/taskctl.mjs',import.meta.url));
const CONNECTOR=fileURLToPath(new URL('./fixtures/conversation-connector.mjs',import.meta.url));
const TASK='task-one';
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const lines=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
const options=value=>Object.entries(value).flatMap(([key,v])=>v===false?[]:v===true?['--'+key.replaceAll('_','-')]:['--'+key.replaceAll('_','-'),String(v)]);
function result(r) {
  assert.ifError(r.error); assert.equal(r.signal,null,r.stderr); assert.equal(r.status,0,r.stderr);
  return JSON.parse(r.stdout);
}
function cli(root,args) {
  return spawnSync(process.execPath,[SCRIPT,'--store',root,...args.map(String)],{encoding:'utf8',timeout:20000,maxBuffer:8*1024*1024});
}
function parallel(t,root,args) {
  const child=spawn(process.execPath,[SCRIPT,'--store',root,...args.map(String)],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  return new Promise((resolve,reject)=>{
    let stdout='',stderr='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('CLI subprocess timed out'));},20000);
    child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',(status,signal)=>{clearTimeout(timer);resolve({stdout,stderr,status,signal});});
  });
}
function fixture(t,{grant=true,bound=true,channels=['dot','feishu'],grantFields={},connectorSettings={}}={}) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'task-conversation-cli-')),root=path.join(tmp,'store'),external=path.join(tmp,'transport');
  fs.mkdirSync(external);t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));let serial=0;
  const file=value=>{const p=path.join(tmp,`input-${++serial}.json`);write(p,value);return p;};
  const raw=(...args)=>cli(root,args),call=(...args)=>result(raw(...args));
  const fail=(pattern,...args)=>{const r=raw(...args);assert.ifError(r.error);assert.equal(r.signal,null);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,pattern);return r.stderr;};
  const register=(id=TASK)=>call('register','--id',id,'--title','Synthetic release task','--goal','Prepare a reviewed release','--status','executing');
  const allow=(fields={})=>call('allow-inbound',...options({id:'grant-one',connector:'fixture-one',account:'account-one',tenant:'tenant-one',sender:'sender-one',destination:'feishu-chat-one',mode:'agent',commands:'query,continue',tasks:TASK,since:'2000-01-01T00:00:00Z',format:'text',...fields}));
  const binding={authorization_ref:'synthetic-user-authorization',verification_ref:'synthetic-platform-evidence',dot:{conversation_id:'dot-chat-one',sender_id:'dot-owner-one',root_id:'dot-original-root'},feishu:{grant_id:'grant-one',root_id:'feishu-original-root'},channels};
  const bind=(fields={},id=TASK)=>call('conversation-bind',id,'--file',file({...binding,...fields}));
  const message=(fields={})=>({id:'message-one',kind:'text',text:'已核对任务范围。\n请在任一会话继续。',privacy:'reviewed',audience:'shared',format:'text',...fields});
  const question=(fields={})=>message({id:'question-message-one',kind:'question',text:'Which format should I prepare?',question_id:'question-one',question_revision:1,permission_class:'ordinary_text',...fields});
  const publish=(v=message(),id=TASK)=>call('conversation-publish',id,'--file',file(v));
  const inbox=[];
  const ingest=event=>{inbox.push(event);write(path.join(external,'inbox.json'),inbox);call('ingest','--connector','fixture-one');return json(path.join(root,'integration.json')).inbox.find(r=>r.envelope?.message_id===event.message_id);};
  const associate=(id=TASK,grantId='grant-one',rootId='feishu-original-root')=>{
    const g=json(path.join(root,'integration.json')).grants.find(g=>g.id===grantId),time=new Date().toISOString();
    ingest({event_id:'binding-event-'+id,message_id:'binding-message-'+id,account_id:g.account,tenant_id:g.tenant,sender_tenant_id:g.tenant,sender_id:g.sender,destination_id:g.destination,type:'text',text:'Associate this synthetic task.',root_id:rootId,received_at:time,occurred_at:time});
    const [entry]=call('message-next','--consumer','binding-worker').messages;assert.ok(entry,'binding inbox entry');assert.equal(entry.grant.id,grantId);
    call('message-record',entry.id,'--token',entry.token,'--decision-file',file({decision:'query',summary:'Verified synthetic association',reply:'Synthetic task association recorded.',task_id:id}));
    call('message-ack',entry.id,'--token',entry.token);call('deliver','--consumer','binding-sender');
    for(const name of ['calls.jsonl','effects.jsonl'])fs.rmSync(path.join(external,name),{force:true});return entry.id;
  };
  const answer=(fields={})=>{
    const channel=fields.channel??'dot';
    const value={id:'answer-one',channel,provider_message_id:'incoming-one',identity:channel==='dot'?{conversation_id:'dot-chat-one',sender_id:'dot-owner-one'}:{account_id:'account-one',tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'feishu-chat-one'},occurred_at:new Date().toISOString(),question_id:'question-one',question_revision:1,in_reply_to:'question-message-one',text:'PDF',privacy:'reviewed',audience:'shared',evidence_ref:'synthetic-verified-envelope',...fields};
    if(channel==='feishu'&&fields.evidence_ref===undefined){
      const sent=ledger().deliveries.find(n=>n.channel==='feishu'&&n.message_id===ledger().messages.find(m=>m.question_id===value.question_id&&m.question_revision===value.question_revision)?.id&&n.receipt?.status==='api_accepted');
      const entry=ingest({event_id:'event-'+value.provider_message_id,message_id:value.provider_message_id,...value.identity,sender_tenant_id:value.identity.tenant_id,type:'text',text:value.text,parent_id:sent?.receipt.message_id,root_id:binding.feishu.root_id,received_at:new Date().toISOString(),occurred_at:value.occurred_at});
      value.evidence_ref=entry?.id??'synthetic-missing-evidence';
    }
    return value;
  };
  const record=v=>call('conversation-answer',TASK,'--file',file(v));
  const input=fields=>answer({question_id:undefined,question_revision:undefined,in_reply_to:(fields?.channel==='feishu'?binding.feishu:binding.dot).root_id,...fields});
  const append=v=>call('conversation-input',TASK,'--file',file(v));
  const consume=(fields={})=>({question_id:'question-one',expected_revision:1,expected_answer_id:'answer-one',expected_input_id:fields.expected_answer_id??'answer-one',authorization_ref:'synthetic-reviewed-answer',action_ref:'synthetic-action-one',...fields});
  const use=v=>call('conversation-consume',TASK,'--file',file(v??consume()));
  const show=()=>call('conversation-show',TASK),next=(channel='dot',fields={})=>call('conversation-next',...options({channel,consumer:'synthetic-worker',...fields}));
  const begin=n=>call('conversation-begin',n.id,'--token',n.lease.token);
  const receipt=(n,fields={})=>call('conversation-receipt',n.id,'--token',n.lease.token,'--file',file({status:'api_accepted',idempotency_key:n.id,message_id:'dot-provider-'+n.id,parent_id:'dot-original-root',root_id:'dot-original-root',thread_id:'dot-provider-thread',...fields}));
  const resolve=(n,fields={})=>call('conversation-resolve',n.id,'--file',file({status:'api_accepted',message_id:'reconciled-'+n.id,evidence:'synthetic-provider-inspection',...fields}));
  const deliver=(fields={})=>call('conversation-deliver',...options({consumer:'synthetic-feishu-worker',...fields}));
  const settle=()=>{let n;while((n=next())){begin(n);receipt(n);}deliver();};
  const ask=(fields={})=>{const q=publish(question(fields));settle();return q;};
  const ledger=()=>json(path.join(root,'conversations.json'));
  // Fault injection only: no concurrent process is alive when fixtures edit persisted state.
  const edit=(name,fn)=>{const p=path.join(root,name),d=json(p);fn(d);write(p,d);};
  const expire=()=>edit('conversations.json',d=>{for(const n of d.deliveries)if(n.lease)n.lease.until='2000-01-01T00:00:00Z';});
  const mode=value=>fs.writeFileSync(path.join(external,'mode'),value);
  call('init');register();call('connect','--id','fixture-one','--module',CONNECTOR,'--settings-file',file({root:external,...connectorSettings}));
  if(grant){allow(grantFields);binding.verification_ref=associate();}if(bound)bind();
  return {tmp,root,external,file,raw,call,fail,register,allow,binding,bind,message,question,publish,answer,record,input,append,consume,use,show,next,begin,receipt,resolve,deliver,ledger,edit,expire,mode,settle,ask,ingest,associate,effects:()=>lines(path.join(external,'effects.jsonl')),calls:()=>lines(path.join(external,'calls.jsonl'))};
}

test('dual publish persists once; dot intent/receipt and mocked Feishu retain original roots',t=>{
  const f=fixture(t),input=f.message();const first=f.publish(input);
  assert.deepEqual(f.publish(input),first);assert.equal(f.show().messages.length,1);assert.equal(f.show().deliveries.length,2);assert.deepEqual(f.effects(),[]);
  const dot=f.next();assert.equal(dot.channel,'dot');assert.equal(dot.adapter,'active_assistant_platform_tool');assert.deepEqual(dot.destination,f.binding.dot);assert.equal(dot.root_id,'dot-original-root');
  assert.equal(dot.message.text,input.text);assert.equal(f.next(),null);
  f.fail(/intent/i,'conversation-receipt',dot.id,'--token',dot.lease.token,'--file',f.file({status:'api_accepted',idempotency_key:dot.id,message_id:'premature'}));
  const intent=f.begin(dot);assert.equal(intent.state,'sending');assert.equal(intent.proceed,true);assert.equal(intent.attempts,1);
  f.fail(/reconcile|intent/i,'conversation-begin',dot.id,'--token',dot.lease.token);
  const receipt=f.receipt(dot);assert.equal(receipt.state,'api_accepted');assert.deepEqual(f.receipt(dot),receipt);
  const feishu=f.deliver().deliveries;assert.equal(feishu.length,1);assert.equal(feishu[0].state,'api_accepted');
  const effect=f.effects()[0];assert.equal(effect.reply_to,'feishu-original-root');assert.equal(effect.reply_in_thread,true);assert.deepEqual(effect.destination,{type:'chat_id',id:'feishu-chat-one'});assert.equal(effect.account_id,'account-one');assert.match(effect.body,/已核对任务范围/);
  const state=f.show();assert.ok(state.deliveries.every(n=>n.state==='api_accepted'));assert.equal(state.deliveries.find(n=>n.channel==='feishu').receipt.root_id,'feishu-original-root');
  assert.deepEqual(f.deliver().deliveries,[]);assert.equal(f.effects().length,1);assert.equal(f.call('doctor').ok,true);
});

test('explicit binding requires a scoped agent grant and is immutable and channel narrow',t=>{
  const f=fixture(t,{bound:false});f.register('task-two');
  f.fail(/scoped|grant/i,'conversation-bind','task-two','--file',f.file(f.binding));
  f.allow({id:'legacy-grant',mode:'commands',commands:'show'});
  f.fail(/agent grant/i,'conversation-bind',TASK,'--file',f.file({...f.binding,feishu:{...f.binding.feishu,grant_id:'legacy-grant'}}));
  for(const channels of [[],['dot'],['dot','dot'],['slack']])f.fail(/scope/i,'conversation-bind',TASK,'--file',f.file({...f.binding,channels}));
  const b=f.bind({channels:['feishu']});assert.deepEqual(f.bind({channels:['feishu']}),b);
  for(const fields of [{channels:['dot','feishu']},{dot:{...f.binding.dot,root_id:'another-root'}},{feishu:{...f.binding.feishu,root_id:'another-root'}}])f.fail(/immutable|provenance/i,'conversation-bind',TASK,'--file',f.file({...f.binding,channels:['feishu'],...fields}));
  f.publish(f.question());assert.deepEqual(f.show().deliveries.map(n=>n.channel),['feishu']);assert.equal(f.next(),null);
  f.fail(/outside task scope/i,'conversation-answer',TASK,'--file',f.file(f.answer({channel:'dot'})));
  f.call('conversation-disable',TASK);f.fail(/disabled|immutable/i,'conversation-bind',TASK,'--file',f.file({...f.binding,channels:['feishu']}));assert.equal(f.next(),null);
});

test('unbound tasks and ordinary ledger changes never become conversation broadcasts',t=>{
  const f=fixture(t,{bound:false});assert.equal(f.show().bound,false);
  f.fail(/unbound|disabled/i,'conversation-publish',TASK,'--file',f.file(f.message()));
  f.call('event',TASK,'--text','Ordinary internal ledger event');f.call('update',TASK,'--summary','Still preparing');
  assert.equal(f.next(),null);assert.deepEqual(f.deliver().deliveries,[]);assert.deepEqual(f.effects(),[]);assert.equal(f.ledger().messages.length,0);
  f.bind();f.call('update',TASK,'--summary','Another internal update');assert.equal(f.show().messages.length,0);
});

test('disabled bindings, grants and connectors stop both newly claimed and already claimed sends',t=>{
  for(const [command,id] of [['conversation-disable',TASK],['deny-inbound','grant-one'],['disconnect','fixture-one']]){
    const f=fixture(t);f.publish();const n=f.next();f.call(command,id);
    f.fail(/disabled|authority/i,'conversation-begin',n.id,'--token',n.lease.token);assert.equal(f.next(),null);assert.deepEqual(f.deliver().deliveries,[]);assert.equal(f.show().authority,'blocked');assert.deepEqual(f.effects(),[]);
    f.fail(/disabled|authority/i,'conversation-publish',TASK,'--file',f.file(f.message({id:'later'})));
  }
});

test('pinned grant scope and connection binding changes stop dispatch rather than silently migrating',t=>{
  for(const mutate of [d=>{d.grants[0].tasks.push('task-two');},d=>{d.connections[0].binding='different-connection-binding';}]){
    const f=fixture(t);f.publish();const n=f.next();f.edit('integration.json',mutate);
    assert.equal(f.show().authority,'blocked');f.fail(/authority|disabled|integrity/i,'conversation-begin',n.id,'--token',n.lease.token);assert.deepEqual(f.deliver().deliveries,[]);assert.deepEqual(f.effects(),[]);
  }
});

test('canonical IDs and inbound origins reject content changes and cross-task reuse',t=>{
  const f=fixture(t);f.ask();f.fail(/conflict/i,'conversation-publish',TASK,'--file',f.file(f.question({text:'A different question'})));
  const a=f.answer();f.record(a);assert.equal(f.record(a).duplicate,true);
  for(const changed of [{text:'Slides'},{id:'different-answer-id'},{provider_message_id:'different-provider-id'}])f.fail(/conflict/i,'conversation-answer',TASK,'--file',f.file({...a,...changed}));
  assert.equal(f.show().answers.length,1);assert.equal(f.show().messages.filter(m=>m.kind==='user_message').length,1);
  f.register('task-two');f.allow({id:'grant-two',tasks:'task-two',sender:'sender-two'});const evidence=f.associate('task-two','grant-two','feishu-second-root');f.bind({verification_ref:evidence,feishu:{grant_id:'grant-two',root_id:'feishu-second-root'}},'task-two');
  f.fail(/conflict/i,'conversation-publish','task-two','--file',f.file(f.question()));
  f.fail(/unique ID/i,'conversation-publish','task-two','--file',f.file(f.question({id:'different-question-message'})));
});

test('inputs from either channel aggregate in commit order without mirroring user messages',t=>{
  for(const channel of ['dot','feishu']){
    const f=fixture(t);f.ask();const first=f.record(f.answer({channel}));assert.equal(first.outcome,'appended');
    const state=f.show(),sync=state.messages.find(m=>m.kind==='user_message');assert.equal(sync.text,'PDF');assert.equal(sync.input_id,first.id);assert.equal(first.receive_sequence,1);assert.equal(sync.sequence,first.sequence);
    assert.equal(sync.role,'user');assert.deepEqual(state.deliveries.filter(n=>n.message_id===sync.id),[]);
    const second=f.record(f.answer({id:'answer-two',provider_message_id:'incoming-two',channel:channel==='dot'?'feishu':'dot'}));
    assert.equal(second.outcome,'appended');assert.equal(second.receive_sequence,2);assert.ok(second.sequence>first.sequence);assert.equal(f.show().deliveries.length,state.deliveries.length);assert.equal(f.show().questions[0].answer_id,second.id);
    f.fail(/revision/i,'conversation-consume',TASK,'--file',f.file(f.consume()));
    const c=f.consume({expected_answer_id:'answer-two'});assert.equal(f.use(c).proceed,true);assert.equal(f.use(c).proceed,false);assert.deepEqual(f.call('queue'),[]);
  }
});

test('later differing inputs append as corrections before or after an already consumed action',t=>{
  const f=fixture(t);f.ask();f.record(f.answer());const first=f.use();assert.equal(first.proceed,true);
  const correction=f.record(f.answer({id:'answer-two',channel:'feishu',provider_message_id:'incoming-two',text:'Actually, prepare slides.'}));assert.equal(correction.outcome,'appended');
  const state=f.show(),q=state.questions[0];assert.equal(q.state,'answered');assert.equal(q.answer_id,correction.id);assert.equal(q.consumed,null);assert.deepEqual(q.consumptions,[first.question.consumed]);
  const m=state.messages.find(m=>m.input_id===correction.id);assert.equal(m.text,'Actually, prepare slides.');assert.equal(m.kind,'user_message');assert.doesNotMatch(JSON.stringify(state.messages),/Conflicting answers|clarify before/);
  assert.equal(f.use(f.consume({expected_answer_id:'answer-two'})).proceed,false);
  assert.equal(f.use(f.consume({expected_answer_id:'answer-two',action_ref:'synthetic-corrective-action'})).proceed,true);assert.equal(f.show().questions[0].consumptions.length,2);
});

test('question updates supersede unsent prompts while older-reference inputs remain ordered conversation',t=>{
  const f=fixture(t);f.publish(f.question());const sent=f.next();f.begin(sent);f.receipt(sent);const claimed=f.next('feishu');
  f.publish(f.question({id:'question-message-two',kind:'question_update',question_revision:2,text:'Please choose the final format.'}));
  assert.ok(f.show().deliveries.filter(n=>n.message_id==='question-message-one'&&n.channel==='feishu').every(n=>n.state==='cancelled'));
  f.fail(/lease|cancelled/i,'conversation-begin',claimed.id,'--token',claimed.lease.token);
  const stale=f.record(f.answer());assert.equal(stale.outcome,'appended');assert.equal(stale.question_revision,1);assert.equal(f.show().questions[0].revision,2);assert.equal(f.show().questions[0].answer_id,stale.id);
  f.fail(/revision/i,'conversation-consume',TASK,'--file',f.file(f.consume()));
  f.fail(/revision/i,'conversation-publish',TASK,'--file',f.file(f.question({id:'question-message-three',kind:'question_update',question_revision:4})));
  f.settle();const fresh=f.record(f.answer({id:'answer-two',provider_message_id:'incoming-two',question_revision:2,in_reply_to:'question-message-two'}));assert.equal(fresh.outcome,'appended');
  f.fail(/revision/i,'conversation-consume',TASK,'--file',f.file(f.consume({expected_revision:2})));
  assert.equal(f.use(f.consume({expected_revision:2,expected_answer_id:'answer-two'})).proceed,true);
});

test('provider receipt correlation is channel-specific and accepted roots never replace original anchors',t=>{
  const f=fixture(t);f.publish(f.question());const dot=f.next();f.begin(dot);f.receipt(dot,{message_id:'dot-question-receipt',root_id:'provider-returned-dot-root'});
  const remote=f.deliver().deliveries[0];assert.equal(remote.root_id,'feishu-original-root');
  f.fail(/correlation|reference/i,'conversation-answer',TASK,'--file',f.file(f.answer({channel:'feishu',in_reply_to:'dot-question-receipt'})));
  f.record(f.answer({channel:'feishu',id:'valid-answer',provider_message_id:'valid-provider-incoming',in_reply_to:remote.receipt.message_id}));
  assert.equal(f.next(),null);f.publish(f.message({id:'assistant-followup',text:'I will prepare the requested format.'}));const sync=f.next();assert.equal(sync.root_id,'dot-original-root');assert.equal(sync.destination.root_id,'dot-original-root');
  assert.equal(f.show().binding.dot.root_id,'dot-original-root');assert.equal(f.show().binding.feishu.root_id,'feishu-original-root');
});

test('identity, reference, timestamp, private content and native approval inputs are rejected atomically',t=>{
  const f=fixture(t);f.publish(f.question());const baseline=f.ledger();
  const invalidAnswers=[
    {identity:{conversation_id:'other-dot',sender_id:'dot-owner-one'}},{identity:{conversation_id:'dot-chat-one',sender_id:'imposter'}},
    ...['account_id','tenant_id','sender_id','destination_id'].map(key=>({channel:'feishu',identity:{...f.answer({channel:'feishu'}).identity,[key]:'wrong'}})),
    {in_reply_to:'unrelated-reference'},{question_id:'unknown-question'},{occurred_at:'2026-01-01T00:00:00'},{privacy:'private'},{audience:'private'},{redacted:'yes'},
    {identity:{conversation_id:'dot-chat-one',sender_id:'dot-owner-one',claimed_owner:true}},{native_approval:{token:'never-store'}},
  ];
  for(const fields of invalidAnswers)f.fail(/identity|correlation|reference|question|scope|shared|redaction|fields|timestamp/i,'conversation-answer',TASK,'--file',f.file(f.answer(fields)));
  for(const fields of [{privacy:'private'},{audience:'private'},{kind:'approval_widget'},{permission_class:'native_approval'},{native_token:'never-store'},{format:'html'},{question_id:'unexpected'}])f.fail(/shared|native|fields|format|question/i,'conversation-publish',TASK,'--file',f.file(f.message(fields)));
  assert.deepEqual(f.ledger(),baseline);assert.deepEqual(f.effects(),[]);
});

test('secrets, unsafe controls and oversized or malformed payloads never enter the ledger or transport',t=>{
  const f=fixture(t);f.publish(f.question());const baseline=f.ledger();
  const bad=['password=synthetic-do-not-persist','access_token: synthetic-do-not-persist','api-key=synthetic-do-not-persist','client secret: synthetic-do-not-persist','sk-0123456789abcdefghijklmnop','AKIA0123456789ABCDEF','-----BEGIN RSA PRIVATE KEY-----','bad\u0000text','bad\u202etext','x'.repeat(4001),'\ud800'];
  for(const text of bad){
    f.fail(/secret|sanitized/i,'conversation-publish',TASK,'--file',f.file(f.message({text})));
    f.fail(/secret|sanitized/i,'conversation-answer',TASK,'--file',f.file(f.answer({text})));
  }
  const malformed=path.join(f.tmp,'malformed.json');fs.writeFileSync(malformed,'{"unfinished":');f.fail(/JSON/i,'conversation-publish',TASK,'--file',malformed);
  const oversized=path.join(f.tmp,'oversized.json');fs.writeFileSync(oversized,' '.repeat(32001));f.fail(/bounded/i,'conversation-publish',TASK,'--file',oversized);
  assert.deepEqual(f.ledger(),baseline);assert.deepEqual(f.effects(),[]);assert.doesNotMatch(JSON.stringify(f.ledger()),/synthetic-do-not-persist|PRIVATE KEY/);
});

test('sanitized redactions append with provenance but cannot be consumed as approval evidence',t=>{
  const f=fixture(t);f.ask();const a=f.record(f.answer({redacted:true,text:'Sanitized incomplete answer'}));
  assert.equal(a.outcome,'appended');const sync=f.show().messages.find(m=>m.kind==='user_message');assert.equal(sync.redacted,true);assert.equal(sync.text,'Sanitized incomplete answer');
  f.fail(/redacted input|approval evidence/i,'conversation-consume',TASK,'--file',f.file(f.consume()));
});

test('expired claims may be reclaimed but expired sending intents become unknown and block catch-up',t=>{
  const f=fixture(t);f.publish();f.publish(f.message({id:'message-two'}));const first=f.next();f.expire();const reclaimed=f.next();
  assert.equal(reclaimed.id,first.id);assert.notEqual(reclaimed.lease.token,first.lease.token);assert.equal(reclaimed.attempts,0);
  f.fail(/lease/i,'conversation-begin',first.id,'--token',first.lease.token);f.begin(reclaimed);f.expire();assert.equal(f.next(),null);
  const stopped=f.show().deliveries.find(n=>n.id===first.id);assert.equal(stopped.state,'delivery_unknown');assert.equal(stopped.receipt.retryable,false);assert.equal(stopped.attempts,1);
  f.fail(/lease/i,'conversation-receipt',first.id,'--token',reclaimed.lease.token,'--file',f.file({status:'api_accepted',idempotency_key:first.id,message_id:'too-late'}));
  f.resolve(stopped);const following=f.next();assert.equal(following.message.id,'message-two');assert.equal(following.root_id,'dot-original-root');
});

test('ambiguous Feishu effects stop retries and catch-up until explicit acceptance reconciliation',t=>{
  for(const mode of ['throw-after-effect','malformed']){
    const f=fixture(t);f.publish();f.publish(f.message({id:'message-two'}));f.mode(mode);const output=f.deliver();
    assert.equal(output.deliveries.length,1);const stopped=output.deliveries[0];assert.equal(stopped.state,'delivery_unknown');assert.equal(stopped.receipt.retryable,false);assert.equal(f.effects().length,1);
    assert.doesNotMatch(JSON.stringify(output),/PRIVATE-SYNTHETIC/);f.mode('accepted');assert.deepEqual(f.deliver().deliveries,[]);assert.equal(f.effects().length,1);
    f.resolve(stopped);assert.equal(f.deliver().deliveries.length,1);assert.equal(f.effects().length,2);assert.equal(f.effects()[0].reply_to,f.effects()[1].reply_to);
  }
});

test('definite no-send and API errors also require reconciliation, never automatic retries',t=>{
  for(const mode of ['not_sent','api_error']){
    const f=fixture(t);f.publish();f.publish(f.message({id:'message-two'}));f.mode(mode);const stopped=f.deliver().deliveries[0];
    assert.equal(stopped.state,mode);assert.equal(f.calls().length,1);assert.equal(f.effects().length,0);f.mode('accepted');assert.deepEqual(f.deliver().deliveries,[]);assert.equal(f.calls().length,1);
    const ready=f.resolve(stopped,{status:'not_sent',message_id:undefined});assert.equal(ready.state,'pending');
    const sent=f.deliver().deliveries;assert.equal(sent.length,2);assert.ok(sent.every(n=>n.state==='api_accepted'));assert.equal(f.effects().length,2);assert.equal(new Set(sent.map(n=>n.receipt.message_id)).size,2);
  }
});

test('provider receipt IDs remain unambiguous and malformed receipts become delivery_unknown',t=>{
  const f=fixture(t);f.publish();f.publish(f.message({id:'message-two'}));const one=f.next();f.begin(one);f.receipt(one,{message_id:'provider-unique'});
  const two=f.next();f.begin(two);f.fail(/receipt ID/i,'conversation-receipt',two.id,'--token',two.lease.token,'--file',f.file({status:'api_accepted',idempotency_key:two.id,message_id:'provider-unique'}));
  const unknown=f.receipt(two,{idempotency_key:'mismatched-key'});assert.equal(unknown.state,'delivery_unknown');
  f.fail(/receipt ID conflict/i,'conversation-resolve',two.id,'--file',f.file({status:'api_accepted',message_id:'provider-unique',evidence:'synthetic-proof'}));
  assert.equal(f.resolve(two,{message_id:'provider-distinct'}).state,'api_accepted');
});

test('a killed sender preserves accepted partial progress and uncertain effects across restarts',t=>{
  const f=fixture(t);for(let i=1;i<=3;i++)f.publish(f.message({id:'message-'+i}));f.mode('crash-on-second-effect');
  const crashed=f.raw('conversation-deliver','--consumer','crashing-worker');assert.equal(crashed.signal,'SIGKILL');assert.equal(f.effects().length,2);
  const before=f.ledger().deliveries.filter(n=>n.channel==='feishu');assert.deepEqual(before.map(n=>n.state),['api_accepted','sending','pending']);
  f.expire();f.mode('accepted');assert.deepEqual(f.deliver().deliveries,[]);const state=f.show();const uncertain=state.deliveries.find(n=>n.state==='delivery_unknown');assert.ok(uncertain);assert.equal(f.effects().length,2);
  f.resolve(uncertain,{message_id:'verified-second-effect'});assert.equal(f.deliver().deliveries.length,1);assert.equal(f.effects().length,3);
  assert.equal(new Set(f.effects().map(e=>e.idempotency_key)).size,3);assert.ok(f.show().deliveries.filter(n=>n.channel==='feishu').every(n=>n.state==='api_accepted'));assert.equal(f.call('doctor').ok,true);
});

test('journal recovery includes the conversation ledger without replaying any send',t=>{
  const f=fixture(t);f.publish();const expected=f.ledger();const p=path.join(f.root,'conversations.json');
  write(path.join(f.root,'.transaction.json'),{schema_version:1,writes:{'conversations.json':JSON.stringify(expected,null,2)+'\n'}});fs.writeFileSync(p,'incomplete-write');
  assert.equal(f.call('doctor').ok,true);assert.deepEqual(f.ledger(),expected);assert.equal(fs.existsSync(path.join(f.root,'.transaction.json')),false);assert.deepEqual(f.effects(),[]);
});

test('parallel CLI inputs append exactly once and concurrent consumers process the latest input once',async t=>{
  const f=fixture(t);f.ask();const inputs=[f.answer(),f.answer({id:'answer-two',channel:'feishu',provider_message_id:'incoming-two'})].map(v=>f.file(v));
  const answers=(await Promise.all(inputs.map(file=>parallel(t,f.root,['conversation-answer',TASK,'--file',file])))).map(result);
  assert.ok(answers.every(a=>a.outcome==='appended'));assert.deepEqual(answers.map(a=>a.receive_sequence).sort(),[1,2]);const latest=answers.find(a=>a.receive_sequence===2);
  const consumeFile=f.file(f.consume({expected_answer_id:latest.id}));
  const operations=Array.from({length:6},()=>parallel(t,f.root,['conversation-consume',TASK,'--file',consumeFile]));operations.push(...inputs.map(file=>parallel(t,f.root,['conversation-answer',TASK,'--file',file])));
  const results=(await Promise.all(operations)).map(result),consumes=results.slice(0,6);
  assert.equal(consumes.filter(r=>r.proceed===true).length,1);assert.equal(consumes.filter(r=>r.proceed===false).length,5);assert.ok(results.slice(6).every(r=>r.duplicate));
  assert.equal(f.show().answers.length,2);assert.equal(f.show().questions[0].state,'consumed');assert.equal(f.show().questions[0].answer_id,latest.id);assert.deepEqual(f.call('queue'),[]);assert.equal(f.call('doctor').ok,true);
});

test('parallel differing channel inputs share a unique deterministic persisted order without conflict locking',async t=>{
  const f=fixture(t);f.ask();const values=[f.answer(),f.answer({id:'answer-two',channel:'feishu',provider_message_id:'incoming-two',text:'Slides'})];
  const answers=(await Promise.all(values.map(v=>parallel(t,f.root,['conversation-answer',TASK,'--file',f.file(v)])))).map(result);
  assert.ok(answers.every(a=>a.outcome==='appended'));assert.deepEqual(answers.map(a=>a.receive_sequence).sort(),[1,2]);const latest=answers.find(a=>a.receive_sequence===2);
  assert.equal(f.show().questions[0].state,'answered');assert.equal(f.use(f.consume({expected_answer_id:latest.id})).proceed,true);
  const persisted=f.show().answers;assert.deepEqual(persisted.map(a=>a.receive_sequence),[1,2]);assert.ok(persisted[0].sequence<persisted[1].sequence);assert.equal(f.effects().length,1);
});

test('start delivers one canonical Feishu message, returns the dot lease and exposes exact topic context',t=>{
  const f=fixture(t);const response={template:'detail',title:'Reviewed release',lead:'The release is ready to inspect.',sections:[{title:'Changes',items:['First checked change','Second checked change']}],links:[{label:'Review report',url:'https://example.test/report'}]};
  f.publish(f.message({response,text:response.lead}));const time=new Date().toISOString();
  f.ingest({event_id:'context-event',message_id:'context-message',account_id:'account-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'feishu-chat-one',type:'text',text:'What is ready?',root_id:'feishu-original-root',received_at:time,occurred_at:time});
  const legacyBefore=json(path.join(f.root,'integration.json')).outbox.length;
  const started=f.call('start','--consumer','active-dot','--timeout-ms','0');assert.deepEqual(started.receive_gaps,[]);assert.equal(started.notifications.length,1);assert.equal(f.effects().length,1);
  const [dot]=started.conversation_deliveries.dot;assert.ok(dot);assert.equal(f.next(),null);assert.equal(dot.delivery_text,f.effects()[0].body);assert.match(dot.delivery_text,/First checked change/);assert.match(dot.delivery_text,/https:\/\/example.test\/report/);
  const [inbound]=started.messages;assert.ok(inbound);assert.equal(inbound.context.task_conversation.matches[0].task_id,TASK);
  const d={decision:'query',summary:'Reviewed bound task answer',reply:response.lead,task_id:TASK};
  f.fail(/conversation-input/i,'message-record',inbound.id,'--token',inbound.token,'--decision-file',f.file(d));
  f.append(f.input({channel:'feishu',provider_message_id:'context-message',evidence_ref:inbound.id,occurred_at:time,text:'What is ready?'}));
  f.fail(/canonical_message_id/i,'message-record',inbound.id,'--token',inbound.token,'--decision-file',f.file({...d,canonical_message_id:'message-one'}));
  f.publish(f.message({id:'message-two',response,text:response.lead}));
  const recorded=f.call('message-record',inbound.id,'--token',inbound.token,'--decision-file',f.file({...d,response,reply:undefined,canonical_message_id:'message-two'}));assert.equal(recorded.task_id,TASK);
  f.call('message-ack',inbound.id,'--token',inbound.token);assert.equal(json(path.join(f.root,'integration.json')).outbox.length,legacyBefore);
  f.begin(dot);f.receipt(dot);f.settle();const again=f.call('start','--consumer','active-dot','--timeout-ms','0');assert.deepEqual(again.notifications,[]);assert.deepEqual(again.conversation_deliveries.dot,[]);assert.equal(f.effects().length,2);
});

test('verified completion creates one canonical pair, suppresses same-route watches and retains other routes',t=>{
  const f=fixture(t);for(const [id,destination] of [['same-route','feishu-chat-one'],['other-route','other-authorized-chat']])f.call('watch',...options({id,connector:'fixture-one',account:'account-one',destination,tasks:TASK,events:'completed',format:'text'}));
  f.fail(/verified completed/i,'conversation-publish',TASK,'--file',f.file(f.message({kind:'completed'})));
  f.call('update',TASK,'--summary','Intermediate change');assert.equal(f.show().messages.length,0);
  f.call('update',TASK,'--status','awaiting_verification','--reason','Synthetic checks ready');f.call('check',TASK,'--name','Synthetic acceptance','--outcome','pass','--evidence','Fabricated isolated verification');
  f.call('complete',TASK,'--summary','Verified synthetic release','--evidence','All requested synthetic checks passed');
  const state=f.show();assert.equal(state.messages.length,1);assert.equal(state.messages[0].kind,'completed');assert.equal(state.deliveries.length,2);
  const notices=f.call('outbox').filter(n=>n.task_id===TASK);assert.equal(notices.length,1);assert.equal(notices[0].route.destination.id,'other-authorized-chat');
  const started=f.call('start','--consumer','completion-worker','--timeout-ms','0');assert.equal(started.notifications.length,2);assert.deepEqual(f.effects().map(e=>e.destination.id).sort(),['feishu-chat-one','other-authorized-chat']);
  assert.equal(f.show().messages.length,1);assert.equal(started.conversation_deliveries.dot.length,1);assert.equal(f.call('show',TASK).status,'completed');
});

test('Feishu-only conversations never claim dot delivery and still accept a verified Feishu answer',t=>{
  const f=fixture(t,{channels:['feishu']});f.ask();assert.equal(f.next(),null);assert.deepEqual(f.show().deliveries.map(n=>n.channel),['feishu']);
  const a=f.record(f.answer({channel:'feishu'}));assert.equal(a.outcome,'appended');assert.equal(f.next(),null);assert.equal(f.show().deliveries.length,1);assert.equal(f.use().proceed,true);
});

test('undelivered questions and invented Feishu provenance cannot supply an answer',t=>{
  const f=fixture(t);f.publish(f.question());f.fail(/correlation|reference/i,'conversation-answer',TASK,'--file',f.file(f.answer()));
  f.settle();f.fail(/verified incoming/i,'conversation-answer',TASK,'--file',f.file(f.answer({channel:'feishu',evidence_ref:'invented-provider-evidence'})));
  const time=new Date().toISOString(),event={event_id:'unrelated-event',message_id:'unrelated-provider-message',account_id:'account-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'feishu-chat-one',type:'text',text:'PDF',root_id:'unrelated-root',received_at:time,occurred_at:time};
  const entry=f.ingest(event);f.fail(/correlation|reference/i,'conversation-answer',TASK,'--file',f.file(f.answer({channel:'feishu',provider_message_id:event.message_id,occurred_at:time,evidence_ref:entry.id})));
  assert.equal(f.show().answers.length,0);assert.equal(f.show().questions[0].state,'pending');
});

test('ordinary topic inputs append without choosing between multiple open questions',t=>{
  const f=fixture(t);f.ask();f.ask({id:'other-question-message',question_id:'question-two'});
  const a=f.append(f.input({channel:'feishu',text:'Also include a short summary.'}));assert.equal(a.outcome,'appended');assert.equal(a.question_id,undefined);assert.ok(f.show().questions.every(q=>q.answer_id===null));
  const exact=f.record(f.answer({channel:'feishu',id:'exact-answer',provider_message_id:'exact-answer-provider'}));assert.equal(exact.outcome,'appended');assert.equal(f.show().questions.find(q=>q.id==='question-two').state,'pending');
});

test('maximum-size user inputs stay local and only the subsequent assistant reply is delivered',t=>{
  const f=fixture(t);f.ask();const value='x'.repeat(4000),a=f.record(f.answer({text:value}));assert.equal(a.outcome,'appended');
  const sync=f.show().messages.find(m=>m.kind==='user_message');assert.equal(sync.text,value);assert.equal(sync.role,'user');assert.deepEqual(f.deliver().deliveries,[]);assert.equal(f.effects().length,1);f.publish(f.message({id:'model-reply',text:'I have incorporated your request.'}));const sent=f.deliver().deliveries;assert.equal(sent.length,1);assert.equal(sent[0].state,'api_accepted');assert.equal(f.effects().length,2);
});

test('new question revisions preserve consumption history and cannot replay the same action reference',t=>{
  const f=fixture(t);f.ask();f.record(f.answer());const first=f.use();assert.equal(first.proceed,true);
  f.ask({id:'question-message-two',kind:'question_update',question_revision:2});f.record(f.answer({id:'answer-two',provider_message_id:'incoming-two',question_revision:2,in_reply_to:'question-message-two'}));
  const same=f.use(f.consume({expected_revision:2,expected_answer_id:'answer-two'}));assert.equal(same.proceed,false);assert.equal(same.reconcile.action_ref,'synthetic-action-one');
  const fresh=f.use(f.consume({expected_revision:2,expected_answer_id:'answer-two',action_ref:'synthetic-action-two'}));assert.equal(fresh.proceed,true);
  const q=f.show().questions[0];assert.equal(q.consumptions.length,2);assert.deepEqual(q.consumptions[0],first.question.consumed);assert.equal(q.consumptions[1].action_ref,'synthetic-action-two');
});


test('older provider timestamps append later and a later ordinary revocation fences stale consumption',t=>{
  const f=fixture(t);f.ask();const first=f.record(f.answer());
  const revocation=f.input({id:'revoke-input',provider_message_id:'revoke-provider',channel:'feishu',occurred_at:'2001-01-01T00:00:00Z',text:'Stop. Do not send the release yet.'});
  const latest=f.append(revocation);assert.equal(latest.outcome,'appended');assert.equal(latest.receive_sequence,first.receive_sequence+1);assert.ok(latest.sequence>first.sequence);assert.ok(Date.parse(latest.occurred_at)<Date.parse(first.occurred_at));
  f.fail(/newer task input/i,'conversation-consume',TASK,'--file',f.file(f.consume()));assert.equal(f.show().questions[0].consumed,null);
  assert.equal(f.append(revocation).duplicate,true);assert.equal(f.show().answers.length,2);assert.deepEqual(f.call('queue'),[]);
});

test('roles are fixed by entry point and a user message can never become an outbound ledger delivery',t=>{
  const f=fixture(t),input=f.input({text:'A private task-scoped instruction to aggregate.'});
  f.fail(/fields/i,'conversation-input',TASK,'--file',f.file({...input,role:'assistant'}));
  f.fail(/fields/i,'conversation-publish',TASK,'--file',f.file(f.message({role:'user'})));
  const before=json(path.join(f.root,'integration.json')).outbox.length,a=f.append(input);assert.equal(a.outcome,'appended');
  assert.equal(f.show().messages[0].role,'user');assert.equal(f.show().deliveries.length,0);assert.equal(json(path.join(f.root,'integration.json')).outbox.length,before);assert.equal(f.next(),null);assert.deepEqual(f.deliver().deliveries,[]);
  f.publish(f.message({text:'I will prepare the requested draft.'}));const state=f.show();assert.equal(state.messages[1].role,'assistant');assert.equal(state.messages[1].sequence,2);assert.equal(state.deliveries.length,2);
  f.edit('conversations.json',d=>{d.deliveries[0].message_id=d.messages[0].id;});f.fail(/invalid conversation delivery/i,'doctor');assert.deepEqual(f.effects(),[]);
});
