import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'managed-session-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const server=path.join(root,'server.mjs'),settings={server,config_ref:path.join(root,'synthetic.yml'),state_dir:root,account_id:'synthetic-app',brand:'feishu'};
  fs.writeFileSync(server,`import fs from 'node:fs'; const root=${JSON.stringify(root)};
    if(process.argv[2]==='start') {fs.writeFileSync(root+'/owned','yes');process.on('SIGTERM',()=>{fs.writeFileSync(root+'/stopped','yes');process.exit(0)});setInterval(()=>{},1000)}
    else console.log(JSON.stringify(fs.existsSync(root+'/owned') || fs.existsSync(root+'/resident/endpoint.json') ? JSON.parse(fs.readFileSync(root+'/health.json','utf8')) : {ok:false}));`);
  const health={ok:true,receiver_connected:true,state_dir:root,identity:{app_id:settings.account_id,brand:'feishu',runtime:'synthetic-runtime'}};
  const write=value=>fs.writeFileSync(path.join(root,'health.json'),JSON.stringify(value));write(health);
  fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify(settings));
  return {root,settings,health,write};
}
async function session(t,f) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/managed-session.mjs',import.meta.url)),'--store',path.join(f.root,'store'),'--settings-file',path.join(f.root,'settings.json')],{stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGTERM')});
  child.stderr.resume();const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const next=async()=>JSON.parse((await lines.next()).value);return {child,next};
}
test('managed session executes explicit CLI commands, rejects store switching and stops only its own child',async t=>{
  const f=fixture(t),s=await session(t,f);
  assert.equal((await s.next()).receiver,'owned');
  s.child.stdin.write(JSON.stringify({id:'init',args:['init']})+'\n');
  assert.equal((await s.next()).ok,true);
  s.child.stdin.write(JSON.stringify({id:'bad',args:['--store','/tmp/other','init']})+'\n');
  assert.equal((await s.next()).event,'invalid-command');
  const exited=once(s.child,'exit');s.child.stdin.end();await exited;
  assert.equal(fs.readFileSync(path.join(f.root,'stopped'),'utf8'),'yes');
});
test('managed session reuses healthy receiver without taking lifecycle ownership',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'resident'));fs.writeFileSync(path.join(f.root,'resident/endpoint.json'),'{}');
  const s=await session(t,f);assert.equal((await s.next()).receiver,'reused');
  const exited=once(s.child,'exit');s.child.stdin.end();await exited;
  assert.equal(fs.existsSync(path.join(f.root,'owned')),false);assert.equal(fs.existsSync(path.join(f.root,'stopped')),false);
});
test('unreachable/disconnected existing endpoint blocks without replacing or killing it',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'resident'));const endpoint=path.join(f.root,'resident/endpoint.json');fs.writeFileSync(endpoint,'{"pid":1}');f.write({...f.health,receiver_connected:false});
  const s=await session(t,f);assert.equal((await s.next()).event,'blocked');await once(s.child,'exit');
  assert.equal(fs.readFileSync(endpoint,'utf8'),'{"pid":1}');assert.equal(fs.existsSync(path.join(f.root,'owned')),false);
});

test('idle managed session exits on SIGTERM even while stdin remains open',async t=>{
  const f=fixture(t),s=await session(t,f);assert.equal((await s.next()).event,'ready');
  const exited=once(s.child,'exit');s.child.kill('SIGTERM');await exited;
  assert.equal(fs.readFileSync(path.join(f.root,'stopped'),'utf8'),'yes');
});
