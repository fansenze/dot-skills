import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const platformOptions={skip:process.platform !== 'linux' ? 'requires Linux and util-linux /usr/bin/flock' : false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let n=0;n<300;n++){if(fn())return;await delay(20);}throw Error('fixture-timeout');}
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-session-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const server=path.join(root,'server.mjs'),settings={server,config_ref:path.join(root,'synthetic.yml'),state_dir:root,account_id:'synthetic-app',brand:'feishu'};
  fs.writeFileSync(server,`import fs from 'node:fs'; const root=${JSON.stringify(root)};
    if(process.argv[2]==='start') {
      const count=root+'/starts';fs.writeFileSync(count,String(Number(fs.existsSync(count)?fs.readFileSync(count):0)+1));
      fs.mkdirSync(root+'/resident',{recursive:true,mode:0o700});
      fs.writeFileSync(root+'/resident/endpoint.json','{"synthetic":true}',{mode:0o600});
      for(const dir of [root+'/resident/resident.lock',root+'/node-listener.lock']){fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(dir+'/pid',String(process.pid),{mode:0o600});}
      fs.writeFileSync(root+'/alive','yes');
      const stop=()=>{fs.rmSync(root+'/alive',{force:true});fs.writeFileSync(root+'/stopped','yes');process.exit(0)};
      process.on('SIGTERM',stop);setTimeout(stop,15000);
      setInterval(()=>{if(fs.existsSync(root+'/stop-receiver'))stop()},20);
    } else console.log(JSON.stringify(fs.existsSync(root+'/alive')?{ok:true,receiver_connected:true}:{ok:false}));`);
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify(settings));
  return {root};
}
async function session(t,f) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/managed-session.mjs',import.meta.url)),'--store',path.join(f.root,'store'),'--settings-file',path.join(f.root,'settings.json')],{stdio:['pipe','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('close',resolve));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;});
  child.stderr.resume();const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>JSON.parse((await lines.next()).value);return {child,next,exit};
}
test('same session checks reuse one receiver and explicit commands still reject store switching',platformOptions,async t=>{
  const f=fixture(t),s=await session(t,f);assert.equal((await s.next()).receiver,'owned');
  for(const id of ['check1','check2']){s.child.stdin.write(JSON.stringify({id,operation:'check'})+'\n');const r=await s.next();assert.equal(r.ok,true);assert.equal(r.id,id);}
  assert.equal(fs.readFileSync(path.join(f.root,'starts'),'utf8'),'1');
  s.child.stdin.write(JSON.stringify({id:'init',args:['init']})+'\n');assert.equal((await s.next()).ok,true);
  s.child.stdin.write(JSON.stringify({id:'bad',args:['--store','/tmp/other','init']})+'\n');assert.equal((await s.next()).event,'invalid-command');
  s.child.stdin.end();await s.exit;assert.equal(fs.existsSync(path.join(f.root,'alive')),false);
});
test('concurrent second supervisor is blocked without changing receiver state',platformOptions,async t=>{
  const f=fixture(t),first=await session(t,f);await first.next();
  const endpoint=fs.readFileSync(path.join(f.root,'resident/endpoint.json'),'utf8');
  const second=await session(t,f);assert.match((await second.next()).reason,/owner-held/);await second.exit;
  assert.equal(fs.readFileSync(path.join(f.root,'resident/endpoint.json'),'utf8'),endpoint);
  assert.equal(fs.readFileSync(path.join(f.root,'starts'),'utf8'),'1');
  first.child.kill('SIGTERM');await first.exit;assert.equal(fs.existsSync(path.join(f.root,'alive')),false);
});
for(const interruption of ['EOF','SIGKILL'])test(`${interruption}: released ownership restores the same store and resumes consumption`,platformOptions,async t=>{
  const f=fixture(t),first=await session(t,f);await first.next();
  const task=async(s,id,args)=>{
    s.child.stdin.write(JSON.stringify({id,args})+'\n');const r=await s.next();
    assert.equal(r.id,id);assert.equal(r.ok,true,JSON.stringify(r));return r.result;
  };
  await task(first,'init',['init']);
  const saved=await task(first,'register',['register','--id','task-original','--title','Synthetic recovery task','--goal','Preserve pending work','--status','executing']);
  await task(first,'schedule',['schedule',saved.id,'--request-id','request-original','--event-id','event-original','--source','fixture','--source-ref','turn-original','--action','execute','--authorization-ref','synthetic-authority','--work-revision',String(saved.work_revision)]);
  const settings=fs.readFileSync(path.join(f.root,'settings.json'),'utf8');
  const index=await task(first,'list',['list','--all']);
  const queue=await task(first,'queue',['queue']);
  const stable=path.join(f.root,'managed-session.flock'),inode=fs.statSync(stable).ino;
  fs.mkdirSync(path.join(f.root,'resident/receipts'),{mode:0o700});fs.writeFileSync(path.join(f.root,'resident/receipts/unknown.json'),'synthetic-unknown');
  fs.writeFileSync(path.join(f.root,'messages.sqlite3'),'synthetic-inbox');
  if(interruption==='EOF'){
    first.child.stdin.end();await first.exit;assert.equal(fs.existsSync(path.join(f.root,'alive')),false);
  }else{
    first.child.kill('SIGKILL');await first.exit;
    const blocked=await session(t,f);assert.match((await blocked.next()).reason,/owner-held/);await blocked.exit;
    assert.equal(fs.existsSync(path.join(f.root,'alive')),true);
    assert.equal(fs.readFileSync(path.join(f.root,'starts'),'utf8'),'1');
    // The mock receiver stops itself through its fixed fixture-only control file.
    fs.writeFileSync(path.join(f.root,'stop-receiver'),'stop');await until(()=>!fs.existsSync(path.join(f.root,'alive')));
    fs.unlinkSync(path.join(f.root,'stop-receiver'));
  }
  const replacement=await session(t,f);assert.equal((await replacement.next()).event,'ready');
  assert.equal(fs.statSync(stable).ino,inode);assert.equal(fs.readFileSync(path.join(f.root,'starts'),'utf8'),'2');
  assert.equal(fs.readFileSync(path.join(f.root,'settings.json'),'utf8'),settings);
  assert.equal(fs.readFileSync(path.join(f.root,'messages.sqlite3'),'utf8'),'synthetic-inbox');
  assert.equal(fs.readFileSync(path.join(f.root,'resident/receipts/unknown.json'),'utf8'),'synthetic-unknown');
  assert.deepEqual(await task(replacement,'list',['list','--all']),index);
  assert.deepEqual(await task(replacement,'show',['show',saved.id]),saved);
  assert.deepEqual(await task(replacement,'queue',['queue']),queue);
  const cycle=await task(replacement,'resume',['start','--consumer','fixture-recovery','--timeout-ms','1']);
  assert.equal(cycle.batch.length,1);assert.equal(cycle.batch[0].id,'request-original');
  assert.equal(cycle.batch[0].mode,'execute');assert.equal(cycle.batch[0].spec.task_id,saved.id);
  replacement.child.stdin.end();await replacement.exit;
});
test('unexpected transient lock shape is preserved and fails closed',platformOptions,async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'managed-session.flock'),'',{mode:0o600});
  fs.mkdirSync(path.join(f.root,'node-listener.lock'),{mode:0o700});fs.writeFileSync(path.join(f.root,'node-listener.lock/unknown'),'keep',{mode:0o600});
  const s=await session(t,f);assert.match((await s.next()).reason,/unexpected-lock-shape/);await s.exit;
  assert.equal(fs.readFileSync(path.join(f.root,'node-listener.lock/unknown'),'utf8'),'keep');assert.equal(fs.existsSync(path.join(f.root,'starts')),false);
});
