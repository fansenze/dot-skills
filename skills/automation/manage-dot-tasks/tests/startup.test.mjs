/** Isolated integrated-startup experiments. No credentials, server or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {run, parse_args} from '../scripts/taskctl.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const lines=p=>fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
async function fixture(t, scope='task-one', watchExtra=[]) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'startup-experiment-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store=path.join(root,'store'), settings=path.join(root,'settings.json');
  fs.writeFileSync(settings,JSON.stringify({root}));
  const call=(...args)=>run(parse_args(['--store',store,...args.map(String)]));
  const cli=(...args)=>{const p=spawnSync(process.execPath,[path.join(ROOT,'scripts/taskctl.mjs'),'--store',store,...args],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
  const connect=['connect','--id','fixture','--module',path.join(ROOT,'tests/fixtures/connector.mjs'),'--settings-file',settings];
  const grant=['allow-inbound','--id','conversation','--connector','fixture','--account','app-one','--tenant','tenant-one','--sender','sender-one','--destination','chat-one','--mode','agent','--commands','query,create,continue','--tasks',scope,'--allow-new','--updates','--format','card'];
  const watch=['watch','--id','updates','--connector','fixture','--account','app-one','--destination','chat-one','--format','card','--events','completed','--tasks',scope,'--initial',...watchExtra];
  cli('init'); await call('register','--id','task-one','--title','Existing authorized task','--goal','Verified outcome','--status','executing');
  cli(...connect); cli(...grant); if(scope!=='none')cli(...watch);
  const state=()=>json(path.join(store,'integration.json'));
  const message=async(kind='continue')=>{
    const now=new Date().toISOString();
    fs.writeFileSync(path.join(root,'inbox.json'),JSON.stringify([{event_id:'event-one',message_id:'message-one',account_id:'app-one',tenant_id:'tenant-one',sender_tenant_id:'tenant-one',sender_id:'sender-one',destination_id:'chat-one',type:'text',text:kind==='create'?'准备发布清单':'继续刚才的任务',received_at:now}]));
    await call('ingest','--connector','fixture'); const claim=(await call('message-next','--consumer','fixture')).messages[0];assert.ok(claim);
    const decision={decision:kind,summary:'Reviewed synthetic request',reply:'已核对范围。',authorization_ref:'synthetic-authority',...(kind==='create'?{title:'发布清单',goal:'核对发布清单',next_action:'检查资料'}:{task_id:'task-one',work_revision:(await call('show','task-one')).work_revision})};
    const file=path.join(root,'decision.json');fs.writeFileSync(file,JSON.stringify(decision));
    const result=await call('message-record',claim.id,'--token',claim.token,'--decision-file',file);
    return {claim,result,file};
  };
  return {root,store,call,cli,connect,grant,watch,state,message,effects:()=>lines(path.join(root,'effects.jsonl'))};
}

test('fresh CLI setup and three resume/idle cycles preserve policies, cutoff and exactly one initial card',async t=>{
  const f=await fixture(t), cutoff=f.state().grants[0].since;
  for(let i=0;i<3;i++){
    assert.equal(f.cli('init').assistant_memory.status,'not_checked');
    f.cli(...f.connect); f.cli(...f.grant); f.cli(...f.watch);
    f.cli('start','--consumer','fixture','--timeout-ms','1');
  }
  const state=f.state();assert.equal(state.connections.length,1);assert.equal(state.watches.length,1);assert.equal(state.grants.length,1);assert.equal(state.grants[0].since,cutoff);
  assert.equal(state.outbox.length,1);assert.equal(f.effects().length,1);assert.equal(f.effects()[0].format,'card');
  assert.equal(f.cli('doctor').ok,true);
});

test('new-task-only setup excludes pre-existing records, and recorded recovery reuses one decision/task/response',async t=>{
  const f=await fixture(t,'none'), {claim,result,file}=await f.message('create');
  assert.deepEqual(claim.context.tasks,[]);assert.equal(f.state().watches.length,0);
  assert.equal((await f.call('message-record',claim.id,'--token',claim.token,'--decision-file',file)).duplicate,true);
  assert.equal((await f.call('list','--all')).length,2);assert.deepEqual(await f.call('queue'),[]);
  await f.call('deliver','--consumer','fixture');await f.call('update',result.task_id,'--summary','Useful progress');
  await f.call('deliver','--consumer','fixture');await f.call('deliver','--consumer','fixture');
  assert.equal(f.effects().length,2);assert.ok(f.effects().every(e=>e.reply_to==='message-one'));
});

for(const variant of ['same-route','disabled','other-format','other-destination','other-event','other-task','second-watch']){
  test(`watch/grant update overlap: ${variant}`,async t=>{
    const extra=variant==='other-format'?['--format','text']:variant==='other-destination'?['--destination','other-chat']:variant==='other-event'?['--events','registered']:variant==='other-task'?['--tasks','unrelated']:[];
    const f=await fixture(t,'task-one',extra);await f.call('deliver','--consumer','fixture');
    await f.message();await f.call('deliver','--consumer','fixture');
    // Decision response is always retained, including reply anchor.
    assert.ok(f.effects().some(e=>e.reply_to==='message-one'));
    if(variant==='disabled')await f.call('unwatch','updates');
    if(variant==='second-watch')await f.call(...f.watch,'--id','updates-two');
    await f.call('deliver','--consumer','fixture');const before=f.effects().length;
    await f.call('update','task-one','--status','awaiting_verification','--reason','Ready to check');await f.call('check','task-one','--name','Acceptance','--outcome','pass','--evidence','Synthetic');await f.call('complete','task-one','--summary','Verified completion','--evidence','Synthetic');await f.call('deliver','--consumer','fixture');
    const added=f.effects().slice(before);
    assert.equal(added.length,['other-format','other-destination','second-watch'].includes(variant)?2:1);
    if(['same-route','second-watch'].includes(variant))assert.ok(added.every(e=>e.reply_to==='message-one'&&e.reply_in_thread===true));
    if(['disabled','other-event','other-task'].includes(variant))assert.equal(added[0].reply_to,'message-one');
  });
}

test('all-scope completion watch does not send intermediate task progress',async t=>{
  const f=await fixture(t,'all');await f.call('deliver','--consumer','fixture');
  const {result}=await f.message('create');await f.call('deliver','--consumer','fixture');
  const before=f.effects().length;await f.call('update',result.task_id,'--summary','New task progress');await f.call('deliver','--consumer','fixture');
  assert.equal(f.effects().length-before,0);
  assert.ok(f.effects().some(e=>e.reply_to==='message-one'));
});

test('missing identities fail closed; generic inspection/start does not re-enable revoked scope',async t=>{
  const f=await fixture(t);const missing=f.grant.filter((v,i,a)=>v!=='--sender'&&a[i-1]!=='--sender');
  await assert.rejects(f.call(...missing,'--id','invalid'),/sender|required/i);
  await f.call('deny-inbound','conversation');await f.call('unwatch','updates');await f.call('init');
  await f.call('start','--consumer','fixture','--timeout-ms','1');
  assert.equal(f.state().grants[0].enabled,false);assert.equal(f.state().watches[0].enabled,false);assert.equal(f.effects().length,0);
});
