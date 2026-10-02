import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startListener, acquireLock, createLog} from '../scripts/runtime.mjs';
import {createNetwork, createClient, createSocket} from '../scripts/transport.mjs';
import {Inbox} from '../scripts/messages.mjs';
import * as lark from '@larksuiteoapi/node-sdk';
const config = () => ({app_id:'cli_0000000000000000',app_secret:'synthetic-secret',brand:'feishu',domain:'https://open.feishu.cn'});
const tick = () => new Promise(r => setImmediate(r));
const deferred = () => {let resolve,reject; const promise = new Promise((r,j) => {resolve=r;reject=j;}); return {promise,resolve,reject};};
function temporary(t) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const success = () => ({code:0,data:{URL:'wss://socket.example.test/ws?device_id=fixture&service_id=fixture',ClientConfig:{PingInterval:120,ReconnectCount:1,ReconnectInterval:10,ReconnectNonce:1}}});
function fixture(t, respond) {
 const network=createNetwork(); t.after(()=>network.close());
 const calls=[];
 network.httpInstance.defaults.adapter=async request=>{calls.push(request);return {status:200,statusText:'OK',headers:{},config:request,data:await respond(request)};};
 const socket=createSocket(config(),network,{});t.after(()=>socket.close({force:true}));
 return {network,socket,calls};
}
test('pre-aborted startup acquires no resources and makes no identity request',async t=>{
 const dir=path.join(temporary(t),'never-created'), c=new AbortController();c.abort();let calls=0;
 await startListener(config(),{stateDir:dir,signal:c.signal,networkFactory:()=>{calls++;throw Error('unexpected');}});
 assert.equal(calls,0);assert.equal(fs.existsSync(dir),false);
});
for (const phase of ['authentication','bot_identity']) test('abort pending '+phase+' cancels SDK HTTP and releases listener lock',async t=>{
 const dir=temporary(t), c=new AbortController(), entered=deferred();let calls=0, observedAbort=false, closed=false;
 const cfg=config();
 await Promise.all([
  startListener(cfg,{stateDir:dir,signal:c.signal,log(){},networkFactory:options=>{
   const network=createNetwork(options), close=network.close;
   network.close=()=>{closed=true;close();};
   network.httpInstance.defaults.adapter=request=>{
    calls++;
    if(phase==='bot_identity' && request.url.includes('tenant_access_token')) return Promise.resolve({status:200,statusText:'OK',headers:{},config:request,data:{code:0,tenant_access_token:'fixture-token',expire:7200}});
    entered.resolve();
    return new Promise((resolve,reject)=>{const abort=()=>{observedAbort=true;reject(Object.assign(Error('private cancellation'),{code:'ERR_CANCELED',config:request}));};request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();});
   };return network;
  },socketFactory:()=>{throw Error('unexpected socket');}}),
  (async()=>{await entered.promise;c.abort();})()
 ]);
 await tick(); assert.equal(closed,true);assert.equal(observedAbort,true);assert.ok(calls>=1);
 assert.equal(cfg.bot_open_id,undefined);assert.equal(fs.existsSync(path.join(dir,'node-listener.lock')),false);
 acquireLock(dir)();
});
test('abort releases resources even if injected identity client ignores cancellation; late completion does not mutate config',async t=>{
 const dir=temporary(t), c=new AbortController(), entered=deferred(), pending=deferred(), cfg=config();let closed=false;
 const run=startListener(cfg,{stateDir:dir,signal:c.signal,log(){},networkFactory:()=>({close(){closed=true;}}),clientFactory:()=>({request(){entered.resolve();return pending.promise;}})});
 await entered.promise;c.abort();await run;assert.equal(closed,true);
 pending.resolve({code:0,bot:{open_id:'ou_late'}});await tick();assert.equal(cfg.bot_open_id,undefined);acquireLock(dir)();
});
test('socket and network cleanup failures preserve primary failure, close inbox and release lock',async t=>{
 const dir=temporary(t), logs=[];let networkClosed=false,inboxClosed=false;
 const close=Inbox.prototype.close;t.mock.method(Inbox.prototype,'close',function(){inboxClosed=true;return close.call(this);});
 await assert.rejects(startListener({...config(),bot_open_id:'ou_fixture'},{stateDir:dir,log:(name,details)=>logs.push({name,details}),
 networkFactory:()=>({close(){networkClosed=true;throw Error('private network error');}}),clientFactory:()=>({}),
 socketFactory:(cfg,n,cb)=>({async start(){cb.onError(Error('primary transport error'));},close(){throw Error('private socket error');}})}),/Long connection failed/);
 assert.equal(networkClosed,true);assert.equal(inboxClosed,true);acquireLock(dir)();
 assert.deepEqual(logs.filter(x=>x.name==='cleanup_failed').map(x=>x.details.resource),['socket','network']);
 assert.equal(logs.at(-1).name,'listener_stopped');assert.doesNotMatch(JSON.stringify(logs),/private|primary transport/);
});
test('cleanup-only failure is sanitized and remaining resources close even if logger throws',async t=>{
 const dir=temporary(t), c=new AbortController();let networkClosed=false;
 await assert.rejects(startListener({...config(),bot_open_id:'ou_fixture'},{stateDir:dir,signal:c.signal,
 log(name){if(name==='cleanup_failed'||name==='listener_stopped')throw Error('private log');},networkFactory:()=>({close(){networkClosed=true;}}),clientFactory:()=>({}),
 socketFactory:()=>({async start(){c.abort();},close(){throw Error('private socket');}})}),e=>/Listener cleanup failed/.test(e.message)&&!/private/.test(e.message));
 assert.equal(networkClosed,true);acquireLock(dir)();
});
test('safe logger only emits allowlisted cleanup resource',t=>{
 const lines=[],log=createLog(temporary(t),line=>lines.push(JSON.parse(line)));
 log('cleanup_failed',{resource:'socket',error:'private'});log('cleanup_failed',{resource:'private'});
 assert.equal(lines[0].resource,'socket');assert.equal(lines[1].resource,undefined);assert.doesNotMatch(JSON.stringify(lines),/private/);
});
for(const data of [undefined,null,{},'invalid']) test('definite discovery rejection stays non-retryable with data '+JSON.stringify(data),async t=>{
 const {socket,calls}=fixture(t,()=>({code:10015,msg:'synthetic rejection',...(data===undefined?{}:{data})}));
 const result=await socket.pullConnectConfig();assert.equal(result.ok,false);assert.equal(result.retryable,false);assert.equal(calls.length,1);
});
test('SDK discovery internal error remains retryable without data',async t=>{
 const {socket}=fixture(t,()=>({code:1000040343,msg:'synthetic'}));
 const result=await socket.pullConnectConfig();assert.deepEqual(result,{ok:false,retryable:true});
});
for(const body of [null,{code:'0'},{code:0},{code:0,data:{}},{code:0,data:{...success().data,URL:'http://socket.example.test'}},{code:0,data:{...success().data,ClientConfig:{}}}]) test('malformed discovery success never reaches connect '+JSON.stringify(body),async t=>{
 const {socket}=fixture(t,()=>body);let connects=0;socket.connect=async()=>{connects++;return false;};
 const result=await socket.pullConnectConfig();assert.equal(result.ok,false);assert.equal(connects,0);
});
test('valid discovery success retains SDK timing and configuration',async t=>{
 const {socket,calls}=fixture(t,success);assert.deepEqual(await socket.pullConnectConfig(),{ok:true});
 assert.equal(calls[0].timeout,15000);assert.equal(socket.wsConfig.getWS('pingInterval'),120000);
});
test('close during actual SDK discovery cancels request and never invokes connect',async t=>{
 const entered=deferred(),pending=deferred();let requestSignal;
 const {socket}=fixture(t,request=>{requestSignal=request.signal;entered.resolve();return pending.promise;});let connects=0;
 socket.connect=async()=>{connects++;return false;};
 await socket.start({eventDispatcher:{}});await entered.promise;socket.close({force:true});
 assert.equal(requestSignal.aborted,true);pending.resolve(success());await tick();await tick();assert.equal(connects,0);
 assert.throws(()=>socket.start({eventDispatcher:{}}),/Closed socket/);
});
test('stale successful discovery is suppressed even when transport ignores cancellation',async t=>{
 const network=createNetwork();t.after(()=>network.close());const pending=deferred(),entered=deferred();
 network.httpInstance.request=async()=>{entered.resolve();return pending.promise;};
 const socket=createSocket(config(),network,{});let connects=0;socket.connect=async()=>{connects++;return false;};
 await socket.start({eventDispatcher:{}});await entered.promise;socket.close({force:true});pending.resolve(success());await tick();await tick();assert.equal(connects,0);
});

test('abort interrupts a pending socket start and suppresses late lifecycle logging',async t=>{
 const dir=temporary(t),c=new AbortController(),entered=deferred(),pending=deferred(),logs=[];let callbacks,closed=false;
 const run=startListener({...config(),bot_open_id:'ou_fixture'},{stateDir:dir,signal:c.signal,log:name=>logs.push(name),networkFactory:()=>({close(){}}),clientFactory:()=>({}),
 socketFactory:(cfg,n,cb)=>{callbacks=cb;return {start(){entered.resolve();return pending.promise;},close(){closed=true;}};}});
 await entered.promise;c.abort();await run;assert.equal(closed,true);acquireLock(dir)();
 const count=logs.length;callbacks.onReady();callbacks.onError(Error('late'));pending.reject(Error('late startup error'));await tick();assert.equal(logs.length,count);
});
test('readiness timeout remains the primary failure when cleanup also fails',async t=>{
 const dir=temporary(t);
 await assert.rejects(startListener({...config(),bot_open_id:'ou_fixture'},{stateDir:dir,readyTimeoutMs:1,log(){},networkFactory:()=>({close(){}}),clientFactory:()=>({}),
 socketFactory:()=>({async start(){},close(){throw Error('private cleanup');}})}),/Long connection was not ready/);
 acquireLock(dir)();
});
test('terminal discovery rejection reaches runtime immediately rather than readiness timeout',async t=>{
 const dir=temporary(t),logs=[];
 await assert.rejects(startListener({...config(),bot_open_id:'ou_fixture'},{stateDir:dir,readyTimeoutMs:1000,log:name=>logs.push(name),networkFactory:options=>{
 const network=createNetwork(options);network.httpInstance.defaults.adapter=async request=>({status:200,statusText:'OK',headers:{},config:request,data:{code:10015,msg:'synthetic rejection'}});return network;
 }}),/Long connection failed/);
 assert.ok(logs.includes('transport_failed'));acquireLock(dir)();
});

test('close between discovery resolution and SDK continuation never constructs a socket',async t=>{
 let connects=0;t.mock.method(lark.WSClient.prototype,'connect',async()=>{connects++;return false;});
 const {socket}=fixture(t,success), update=socket.wsConfig.updateWs.bind(socket.wsConfig);
 socket.wsConfig.updateWs=options=>{update(options);queueMicrotask(()=>queueMicrotask(()=>socket.close({force:true})));};
 await socket.reConnect(true);assert.equal(connects,0);
});

test('held lock rejection does not log a stop for the existing healthy listener',async t=>{
 const dir=temporary(t),release=acquireLock(dir),logs=[];let calls=0;
 try {
 await assert.rejects(startListener(config(),{stateDir:dir,log:name=>logs.push(name),networkFactory:()=>{calls++;throw Error('unexpected');}}),/lock exists/);
 assert.equal(calls,0);assert.deepEqual(logs,[]);assert.equal(fs.existsSync(path.join(dir,'node-listener.lock')),true);
 } finally { release(); }
});
