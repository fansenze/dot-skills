import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Store,atomic,fileHash,enqueue,exportBatch,processBatch,importReceipts,getJob,awaitReceipt} from '../scripts/core.mjs';
import {ROOT,FILES,makePackage} from '../scripts/package.mjs';
const example=JSON.parse(fs.readFileSync(path.join(ROOT,'references/orchestration-example.json'),'utf8'));
const cli=fileURLToPath(new URL('../scripts/bridge.mjs',import.meta.url));
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-orchestration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const local=path.join(dir,'local'),dot=path.join(dir,'dot');fs.mkdirSync(local);fs.mkdirSync(dot);
  const server=path.join(local,'server.mjs'),config=path.join(local,'selected-config.json'),effects=path.join(local,'effects.jsonl');
  fs.writeFileSync(config,'{"app_id":"fixture-app","app_secret":"fixture-credential-stays-local"}');
  fs.writeFileSync(server,`import fs from 'node:fs';const args=process.argv.slice(2),command=args[0],get=k=>args[args.indexOf(k)+1];
if(command==='check'){fs.accessSync(get('--config'));console.log(JSON.stringify({ok:true}));}
else if(command==='identity'){console.log(JSON.stringify({app_id:'fixture-app',brand:'feishu'}));}
else if(command==='capabilities'){console.log(JSON.stringify({protocol_version:1,formats:['text','markdown','card'],send:true,reply:true,receive:true,durable_cursor:true}));}
else if(command==='send'){let body='';for await(const chunk of process.stdin)body+=chunk;const fd=fs.openSync(${JSON.stringify(effects)},'a');fs.writeSync(fd,JSON.stringify({body,config:get('--config'),key:get('--idempotency-key')})+'\\n');fs.fsyncSync(fd);fs.closeSync(fd);console.log(JSON.stringify({ok:true,message_id:'fixture-accepted-message',idempotency_key:get('--idempotency-key')}));}
else throw Error('Unexpected fixture operation');`);
  const pub={remote_id:'selected-computer',account_id:'fixture-app',brand:'feishu',server_sha256:fileHash(server)};
  const vars={LOCAL_SERVER:server,LOCAL_CONFIG:config,LOCAL_STORE:path.join(local,'store'),CLOUD_STORE:path.join(dot,'store'),LOCAL_BINDING:path.join(local,'binding.json'),PUBLIC_BINDING:path.join(dot,'binding.json'),THREAD_ID:'verified-fixture-task',JOB_INPUT:path.join(dot,'job.json'),DOT_BATCH:path.join(dot,'batch.json'),LOCAL_BATCH:path.join(local,'batch.json'),LOCAL_RECEIPTS:path.join(local,'receipts.json'),DOT_RECEIPTS:path.join(dot,'receipts.json')};
  atomic(vars.LOCAL_BINDING,{...pub,server,config_ref:config,state_dir:path.join(local,'receiver')});atomic(vars.PUBLIC_BINDING,pub);atomic(vars.JOB_INPUT,example.job);
  return {dir,local,dot,vars,effects,config,resolve:value=>value.replace(/\$\{(\w+)\}/g,(_,k)=>{assert.ok(k in vars,k);return vars[k];})};
}
function executeStep(f,step) {
  assert.ok(['local','dot'].includes(step.actor));
  if(step.kind==='platform') {
    assert.equal(step.actor,'dot');assert.equal(f.resolve(step.thread),f.vars.THREAD_ID);
    // Simulated task message/read transports only the protocol envelope. This
    // fixture copy is not a production arbitrary-file bridge operation.
    if(step.tool==='cloud_threads.send_message') {
      assert.equal(step.payload,'${DOT_BATCH}');assert.equal(step.worker_input,'${LOCAL_BATCH}');
      const bytes=fs.readFileSync(f.resolve(step.payload));const batch=JSON.parse(bytes);assert.equal(batch.version,1);assert.ok(Array.isArray(batch.jobs));
      fs.writeFileSync(f.resolve(step.worker_input),bytes);return {boundary:'message'};
    }
    assert.equal(step.tool,'cloud_threads.read');assert.equal(step.worker_output,'${LOCAL_RECEIPTS}');assert.equal(step.receipt_input,'${DOT_RECEIPTS}');
    const bytes=fs.readFileSync(f.resolve(step.worker_output));assert.ok(Array.isArray(JSON.parse(bytes).receipts));fs.writeFileSync(f.resolve(step.receipt_input),bytes);return {boundary:'read'};
  }
  assert.ok(['server','bridge'].includes(step.kind));
  if(step.kind==='server') assert.equal(step.actor,'local','Remote server/configuration commands must stay on the selected computer');
  const args=step.args.map(f.resolve);
  if(step.actor==='dot') {assert.ok(args.every(arg=>!arg.startsWith(f.local)),'Cloud CLI cannot open local-computer paths');assert.ok(!args.includes('--config'));}
  const result=spawnSync(process.execPath,[step.kind==='server'?f.vars.LOCAL_SERVER:cli,...args],{cwd:step.actor==='local'?f.local:f.dot,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}

test('documented two-environment setup reuses bindings and exact task batch/receipt replay has one effect',t=>{
  const f=fixture(t),before=fs.readFileSync(f.config);assert.equal(example.scope,'remote-operations-only');
  assert.equal(example.task_selection.if_missing.tool,'cloud_threads.create');
  example.setup.forEach(step=>executeStep(f,step));
  assert.ok(!fs.existsSync(f.effects),'Configuration alone must not send');
  for(const step of example.reuse) assert.equal(executeStep(f,step).existing,true);
  example.cycle.forEach(step=>executeStep(f,step));example.replay.forEach(step=>executeStep(f,step));
  assert.equal(fs.readFileSync(f.effects,'utf8').trim().split('\n').length,1);assert.deepEqual(fs.readFileSync(f.config),before);
  const cloud=fs.readFileSync(path.join(f.vars.CLOUD_STORE,'bridge.json'),'utf8');assert.ok(!cloud.includes(f.config));assert.ok(!cloud.includes('fixture-credential-stays-local'));
  assert.equal(JSON.parse(cloud).jobs[0].receipt.result.status,'api_accepted');
  // These mutations model the two routing regressions the transcript must catch.
  assert.throws(()=>executeStep(f,{actor:'dot',kind:'server',args:['identity','--config','${LOCAL_CONFIG}']}),/must stay/);
  assert.throws(()=>executeStep(f,{actor:'local',kind:'skill',name:'feishu-message-server'}));
});

test('late receipt is imported after a bounded waiter ends without a new send job',async t=>{
  const f=fixture(t);example.setup.forEach(step=>executeStep(f,step));
  const cloud=new Store(f.vars.CLOUD_STORE),local=new Store(f.vars.LOCAL_STORE);
  await enqueue(cloud,example.job);await assert.rejects(awaitReceipt(cloud,example.job.id,undefined,1),/receipt pending/);
  const batch=await exportBatch(cloud,1),receipts=await processBatch(local,batch);await importReceipts(cloud,receipts);
  assert.equal((await getJob(cloud,example.job.id)).receipt.result.message_id,'fixture-accepted-message');
  await processBatch(local,batch,()=>assert.fail('Late receipt does not authorize redispatch'));
  assert.equal(fs.readFileSync(f.effects,'utf8').trim().split('\n').length,1);
  assert.equal((await exportBatch(cloud)).jobs.length,0);
});

test('portable manifest includes routing resources and excludes runtime state and non-Node scripts',t=>{
  const f=fixture(t),output=path.join(f.dir,'bridge.tgz'),result=makePackage(output);
  const listing=spawnSync('tar',['-tzf',output],{encoding:'utf8'});assert.equal(listing.status,0,listing.stderr);
  assert.deepEqual(listing.stdout.trim().split('\n').sort(),FILES.map(p=>'remote-config-bridge/'+p).sort());assert.equal(result.files,FILES.length);
  assert.ok(FILES.includes('references/orchestration-example.json'));assert.ok(FILES.includes('agents/openai.yaml'));
  assert.ok(!FILES.some(p=>/bridge\.json|config\.json|\.py$|\.sh$|node_modules|receipts/.test(p)));
  assert.throws(()=>makePackage(path.join(ROOT,'unwanted.tgz')),/outside the skill/);
});
