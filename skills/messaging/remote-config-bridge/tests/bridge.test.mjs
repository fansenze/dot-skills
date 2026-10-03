import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {Store,hash,fileHash,atomic,enqueue,exportBatch,processBatch,importReceipts,getJob,invoke} from '../scripts/core.mjs';
async function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const server=path.join(dir,'fixture.mjs');fs.writeFileSync(server,`let s='';for await(const c of process.stdin)s+=c;const a=process.argv.slice(2),key=a[a.indexOf('--idempotency-key')+1];console.log(JSON.stringify({ok:true,message_id:'message-fixture',idempotency_key:key}));`);const pub={remote_id:'fixture',account_id:'fixture-app',brand:'feishu',server_sha256:fileHash(server)},local={...pub,server,config_ref:path.join(dir,'unused-config'),state_dir:path.join(dir,'inbox')};const cloud=new Store(path.join(dir,'cloud')),worker=new Store(path.join(dir,'local'));await cloud.init('cloud',pub,'fixture-thread');await worker.init('local',local);return {dir,cloud,worker,pub,local};}
const send=(body='hello',key='key-fixture')=>({id:'send-'+hash(key).slice(0,48),operation:'send',authorization_ref:'fixture-authorization',payload:{account_id:'fixture-app',destination:{id:'fixture-chat',type:'chat_id'},format:'text',body,idempotency_key:key}});
test('durable export/process/import and exact replay invoke actual fixed Node CLI only once',async t=>{const {cloud,worker}=await fixture(t);const input=send('Unicode 世界; $(never-execute)');await enqueue(cloud,input);const b=await exportBatch(cloud);let calls=0;const run=async(...args)=>{calls++;return invoke(...args);};const r=await processBatch(worker,b,run);assert.equal(r.receipts[0].result.status,'api_accepted');assert.deepEqual(await processBatch(worker,b,run),r);assert.equal(calls,1);await importReceipts(cloud,r);await importReceipts(cloud,r);assert.equal((await exportBatch(cloud)).jobs.length,0);assert.equal((await getJob(cloud,input.id)).receipt.result.message_id,'message-fixture');});
test('same key payload mismatch rejected before another external effect',async t=>{const {cloud,worker}=await fixture(t);await enqueue(cloud,send());await assert.rejects(enqueue(cloud,send('changed')),/mismatch/);const b=await exportBatch(cloud);b.jobs[0].payload.body='tampered';await assert.rejects(processBatch(worker,b,()=>assert.fail()),/hash mismatch/);});
test('crash after durable intent gives unknown without blind resend',async t=>{const {cloud,worker}=await fixture(t);await enqueue(cloud,send());const b=await exportBatch(cloud);await worker.lock(()=>{const d=worker.read();d.jobs.push({job:b.jobs[0],state:'intent',receipt:null});worker.save(d);});const r=await processBatch(worker,b,()=>assert.fail('must not send'));assert.equal(r.receipts[0].result.status,'delivery_unknown');assert.deepEqual(await processBatch(worker,b,()=>assert.fail()),r);});
test('invalid CLI response remains unknown and bounded diagnostics omit secrets',async t=>{const {cloud,worker}=await fixture(t);await enqueue(cloud,send());const r=await processBatch(worker,await exportBatch(cloud),async()=>({secret:'never-record',status:'api_accepted'}));assert.equal(r.receipts[0].result.status,'delivery_unknown');assert.ok(!JSON.stringify(worker.read()).includes('never-record'));});
test('cursor pages retain opaque position, duplicates replay, new request fetches again',async t=>{const {cloud,worker}=await fixture(t);const input={id:'receive-first',operation:'receive',authorization_ref:'fixture',payload:{cursor:'opaque-before',limit:2}};await enqueue(cloud,input);const b=await exportBatch(cloud);let n=0;const run=async(_,j)=>{n++;assert.equal(j.payload.cursor,'opaque-before');return {protocol_version:1,messages:[{cursor:'opaque-after',message:{message_id:'msg1',text:'untrusted'}}],next_cursor:'opaque-after',has_more:true};};const r=await processBatch(worker,b,run);await processBatch(worker,b,run);assert.equal(n,1);await importReceipts(cloud,r);assert.equal((await getJob(cloud,input.id)).receipt.result.page.next_cursor,'opaque-after');});
test('receipt substitution and altered replay rejected',async t=>{const {cloud,worker}=await fixture(t);await enqueue(cloud,send());const r=await processBatch(worker,await exportBatch(cloud));await importReceipts(cloud,r);const changed=structuredClone(r);changed.receipts[0].result.message_id='different';await assert.rejects(importReceipts(cloud,changed),/replay mismatch/);});
test('binding mismatch, code change, oversized payload and cursor rejected',async t=>{const {cloud,worker,local}=await fixture(t);await assert.rejects(enqueue(cloud,send('x'.repeat(29000))));await assert.rejects(enqueue(cloud,{id:'receive-x',operation:'receive',authorization_ref:'fixture',payload:{cursor:'a'.repeat(4097),limit:1}}));await enqueue(cloud,send());const b=await exportBatch(cloud);await assert.rejects(processBatch(worker,{...b,binding_hash:'wrong'},()=>assert.fail()),/binding mismatch/);fs.appendFileSync(local.server,'\n// changed');const r=await processBatch(worker,b);assert.equal(r.receipts[0].result.status,'delivery_unknown');});
test('multiple processes enqueue one stable job without lost writes',async t=>{const {cloud,dir}=await fixture(t);const input=path.join(dir,'job.json');atomic(input,send());const cli=new URL('../scripts/bridge.mjs',import.meta.url).pathname;const a=spawnSync(process.execPath,[cli,'enqueue','--store',cloud.root,'--input',input]);const b=spawnSync(process.execPath,[cli,'enqueue','--store',cloud.root,'--input',input]);assert.equal(a.status,0);assert.equal(b.status,0);assert.equal(cloud.read().jobs.length,1);});

test('adapter emits a job and resumes only after durable imported receipt',async t=>{const {cloud,worker}=await fixture(t);const {createConnector}=await import('../scripts/adapter.mjs');const adapter=createConnector({store:cloud.root,authorization_ref:'fixture'});assert.equal(adapter.capabilities().durable_cursor,true);const input=send().payload,pending=adapter.send(input);let b;for(let i=0;i<100;i++){b=await exportBatch(cloud);if(b.jobs.length)break;await new Promise(r=>setTimeout(r,10));}assert.equal(b.jobs.length,1);const receipts=await processBatch(worker,b);await importReceipts(cloud,receipts);assert.equal((await pending).status,'api_accepted');const again=await adapter.send(input);assert.equal(again.message_id,'message-fixture');});
test('output overflow is unknown without repeated invocation',async t=>{const {cloud,worker,local}=await fixture(t);fs.writeFileSync(local.server,`process.stdout.write('x'.repeat(4*1024*1024+10));`);const d=worker.read();d.binding.server_sha256=fileHash(local.server);worker.save(d);const cd=cloud.read();cd.binding.server_sha256=d.binding.server_sha256;cloud.save(cd);await enqueue(cloud,send());const b=await exportBatch(cloud),r=await processBatch(worker,b);assert.equal(r.receipts[0].result.status,'delivery_unknown');assert.deepEqual(await processBatch(worker,b,()=>assert.fail()),r);});
test('simultaneous CLI producers serialize without losing jobs',async t=>{const {cloud,dir}=await fixture(t);const {spawn}=await import('node:child_process');const cli=new URL('../scripts/bridge.mjs',import.meta.url).pathname;const commands=Array.from({length:6},(_,i)=>{const input=path.join(dir,'job-'+i+'.json');atomic(input,send('message '+i,'key-'+i));return new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cli,'enqueue','--store',cloud.root,'--input',input],{stdio:'ignore'});p.on('error',reject);p.on('close',resolve);});});assert.deepEqual(await Promise.all(commands),[0,0,0,0,0,0]);assert.equal(cloud.read().jobs.length,6);});
test('hard-killed CLI after send intent is recovered without dispatch',async t=>{const {cloud,worker,dir}=await fixture(t);await enqueue(cloud,send());const batch=await exportBatch(cloud),file=path.join(dir,'batch.json');atomic(file,batch);const helper=path.join(dir,'crash.mjs'),core=new URL('../scripts/core.mjs',import.meta.url).href;fs.writeFileSync(helper,`import {Store,processBatch,boundedRead} from ${JSON.stringify(core)};await processBatch(new Store(${JSON.stringify(worker.root)}),boundedRead(${JSON.stringify(file)}),async()=>{process.kill(process.pid,'SIGKILL');});`);const result=spawnSync(process.execPath,[helper]);assert.equal(result.signal,'SIGKILL');const receipts=await processBatch(worker,batch,()=>assert.fail('no resend'));assert.equal(receipts.receipts[0].result.status,'delivery_unknown');});

test('release survives next generation replacing its empty lock directory',async t=>{
 const {cloud,dir}=await fixture(t),lock=path.join(cloud.root,'.lock'),candidate=path.join(dir,'next-lock');
 fs.mkdirSync(candidate);fs.writeFileSync(path.join(candidate,'next-token.json'),JSON.stringify({token:'next-token',pid:process.pid,host:os.hostname()}));
 const unlink=fs.unlinkSync;let injected=false;
 fs.unlinkSync=function(file){const result=unlink.call(fs,file);if(path.dirname(file)===lock&&!injected){injected=true;fs.renameSync(candidate,lock);}return result;};
 try {assert.deepEqual(await cloud.lock(()=>({committed:true})),{committed:true});assert.equal(injected,true);assert.ok(fs.existsSync(path.join(lock,'next-token.json')));}
 finally {fs.unlinkSync=unlink;fs.rmSync(lock,{recursive:true,force:true});}
});
test('stale reaper preserves a replacement generation and retries acquisition',async t=>{
 const {cloud,dir}=await fixture(t),lock=path.join(cloud.root,'.lock'),candidate=path.join(dir,'next-lock');
 // Obtain a real terminated PID, rather than guessing that a PID is dead.
 const dead=spawnSync(process.execPath,['-e','']);assert.equal(dead.status,0);
 fs.mkdirSync(lock);fs.writeFileSync(path.join(lock,'stale-token.json'),JSON.stringify({token:'stale-token',pid:dead.pid,host:os.hostname()}));
 fs.mkdirSync(candidate);fs.writeFileSync(path.join(candidate,'next-token.json'),JSON.stringify({token:'next-token',pid:process.pid,host:os.hostname()}));
 const unlink=fs.unlinkSync;let injected=false,replacementObserved=false;
 fs.unlinkSync=function(file){const result=unlink.call(fs,file);if(file===path.join(lock,'stale-token.json')&&!injected){injected=true;fs.renameSync(candidate,lock);setTimeout(()=>{replacementObserved=fs.existsSync(path.join(lock,'next-token.json'));unlink(path.join(lock,'next-token.json'));fs.rmdirSync(lock);},60);}return result;};
 try {assert.equal(await cloud.lock(()=>42),42);assert.equal(injected,true);assert.equal(replacementObserved,true);}
 finally {fs.unlinkSync=unlink;}
});

test('bridge adapter preserves optional provider context through durable receipts without granting identity', async t => {
 const {cloud, worker} = await fixture(t);
 const {createConnector} = await import('../scripts/adapter.mjs');
 const adapter = createConnector({store:cloud.root, authorization_ref:'fixture'});
 const controller = new AbortController(); t.after(() => controller.abort());
 const pending = adapter.receive({signal:controller.signal});
 const base = {event_id:'event-fixture', message_id:'message-fixture', app_id:'fixture-app', tenant_key:'fixture-tenant',
   sender_tenant_key:'fixture-tenant', sender_open_id:'fixture-sender', chat_id:'fixture-chat', message_type:'text',
   received_at:1700000000, bot_mention_keys:['@_bot'], text:'@_bot Do this\n  then this'};
 const context = {parent_id:'om_parent', root_id:'om_root', thread_id:'omt_thread'};
 const invalid = [null, '', ' ', 'bad\nID', 'x'.repeat(257), {}, ['om_array'], 42];
 const messages = [base, {...base,...context}, ...invalid.map(v => ({...base,parent_id:v,root_id:v,thread_id:v}))]
   .map((message,i) => ({cursor:'cursor-'+i,message}));
 let batch; for(let i=0;i<100;i++){batch=await exportBatch(cloud);if(batch.jobs.length)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(batch.jobs.length,1);
 const receipts = await processBatch(worker,batch,async()=>({protocol_version:1,messages,next_cursor:'cursor-end',has_more:false}));
 await importReceipts(cloud,receipts);
 const result = await pending;
 assert.equal(result.next_cursor,'cursor-end');
 for(const [i,event] of result.events.entries()){
   assert.equal(event.text,'Do this\n  then this'); assert.equal(event.sender_id,'fixture-sender');
   for(const [key,value] of Object.entries(context)) {
     if(i===1)assert.equal(event[key],value);else assert.equal(Object.hasOwn(event,key),false);
   }
 }
});
