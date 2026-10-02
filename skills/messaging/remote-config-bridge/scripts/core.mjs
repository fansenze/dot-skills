import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
export const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const hash=v=>crypto.createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
export const fileHash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail=()=>{throw Error('Invalid bridge data');};
export const id=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v)?v:fail();
const text=(v,max=2048)=>typeof v==='string'&&v.length&&v.length<=max&&!/[\x00-\x1f\x7f]/.test(v)?v:fail();
const keys=(v,allowed)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))fail();};
export function boundedRead(file,max=4*1024*1024){const fd=fs.openSync(file,'r');try{if(fs.fstatSync(fd).size>max)fail();return JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}}
export function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+crypto.randomUUID();let fd;try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fd=null;fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}finally{if(fd!==null&&fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}}
export function publicBinding(b){keys(b,['remote_id','account_id','brand','server_sha256']);id(b.remote_id);text(b.account_id,256);if(!['feishu','lark'].includes(b.brand)||!/^[a-f0-9]{64}$/.test(b.server_sha256))fail();return structuredClone(b);}
export function localBinding(b){keys(b,['remote_id','account_id','brand','server_sha256','server','config_ref','state_dir']);publicBinding(Object.fromEntries(['remote_id','account_id','brand','server_sha256'].map(k=>[k,b[k]])));for(const k of ['server','config_ref','state_dir'])if(!path.isAbsolute(text(b[k])))fail();if(fileHash(b.server)!==b.server_sha256)throw Error('Server code binding mismatch');return structuredClone(b);}
export class Store{
 constructor(root){this.root=path.resolve(root);this.file=path.join(this.root,'bridge.json');}
 async lock(fn) {
  fs.mkdirSync(this.root, {recursive: true, mode: 0o700});
  const lock = path.join(this.root, '.lock');
  const candidate = lock + '-' + crypto.randomUUID();
  const token = crypto.randomUUID();
  const owner = {token, pid: process.pid, host: os.hostname()};
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, token + '.json'), JSON.stringify(owner));
  let acquired = false;
  const removeEmpty = () => {
   // A new owner can replace an empty directory before this rmdir. Never
   // recursively remove it; a populated next generation must survive.
   try { fs.rmdirSync(lock); }
   catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  };
  try {
   for (let i = 0; i < 200; i++) {
    try { fs.renameSync(candidate, lock); acquired = true; break; }
    catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    let names;
    try { names = fs.readdirSync(lock); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (names.length === 0) { removeEmpty(); await delay(25); continue; }
    if (names.length !== 1) throw Error('Invalid lock contents; preserve for inspection');
    let prior;
    try { prior = boundedRead(path.join(lock, names[0])); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (names[0] !== prior.token + '.json' || !Number.isSafeInteger(prior.pid) || prior.pid < 1) {
     throw Error('Invalid lock owner; preserve for inspection');
    }
    if (prior.host === os.hostname()) {
     let dead = false;
     try { process.kill(prior.pid, 0); }
     catch (error) { dead = error.code === 'ESRCH'; }
     if (dead) {
      // Only this generation's unique token can be removed. A competing
      // reaper may already have removed it and installed a different owner.
      try { fs.unlinkSync(path.join(lock, prior.token + '.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      removeEmpty();
     }
    }
    await delay(25);
   }
   if (!acquired) throw Error('Bridge store busy');
   return await fn();
  } finally {
   if (acquired) {
    try { fs.unlinkSync(path.join(lock, token + '.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    removeEmpty();
   } else {
    // The candidate is private to this acquisition, unlike the shared lock.
    try { fs.unlinkSync(path.join(candidate, token + '.json')); fs.rmdirSync(candidate); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
   }
  }
 }

 read(){const d=boundedRead(this.file,32*1024*1024);if(d.version!==1||!Array.isArray(d.jobs))fail();return d;}
 save(d){if(Buffer.byteLength(JSON.stringify(d))>32*1024*1024)throw Error('Bridge store capacity reached; preserve jobs');atomic(this.file,d);}
 async init(role,binding,thread_id=null){if(!['cloud','local'].includes(role))fail();const b=role==='local'?localBinding(binding):publicBinding(binding);if(thread_id!==null)text(thread_id,256);return this.lock(()=>{if(fs.existsSync(this.file)){const d=this.read();if(d.role!==role||hash(d.binding)!==hash(b)||d.thread_id!==thread_id)throw Error('Existing binding differs');return {role,existing:true};}this.save({version:1,role,binding:b,thread_id,jobs:[]});return {role,existing:false};});}
}
export function validateJob(j,binding){keys(j,['id','operation','payload','authorization_ref','binding_hash','payload_hash']);id(j.id);text(j.authorization_ref);if(j.binding_hash!==hash(publicBinding(binding)))throw Error('Remote binding mismatch');const p=j.payload;if(['send','reply'].includes(j.operation)&&j.id!=='send-'+hash(p?.idempotency_key).slice(0,48))throw Error('Send job ID must derive from idempotency key');
 if(j.operation==='send'||j.operation==='reply'){keys(p,['account_id','destination','reply_to','format','body','idempotency_key']);if(p.account_id!==binding.account_id||!['text','markdown','card'].includes(p.format)||!/^[A-Za-z0-9_-]{1,50}$/.test(p.idempotency_key))fail();if(j.operation==='reply')text(p.reply_to,256);else{keys(p.destination,['id','type']);text(p.destination.id,256);if(!['chat_id','open_id','user_id','union_id','email'].includes(p.destination.type))fail();}if((p.format!=='card'&&typeof p.body!=='string')||Buffer.byteLength(JSON.stringify(p.body)??'')>28000||p.body===undefined)fail();}
 else if(j.operation==='receive'){keys(p,['cursor','limit']);if(p.cursor!==null&&p.cursor!==undefined)text(p.cursor,4096);if(!Number.isInteger(p.limit)||p.limit<1||p.limit>1000)fail();}
 else fail();if(j.payload_hash!==hash({operation:j.operation,payload:p,authorization_ref:j.authorization_ref,binding_hash:j.binding_hash}))throw Error('Payload hash mismatch');return j;}
export function makeJob(binding,input){keys(input,['id','operation','payload','authorization_ref']);const j={...input,binding_hash:hash(publicBinding(binding))};j.payload_hash=hash({operation:j.operation,payload:j.payload,authorization_ref:j.authorization_ref,binding_hash:j.binding_hash});return validateJob(j,binding);}
export async function enqueue(store,input){return store.lock(()=>{const d=store.read();if(d.role!=='cloud')fail();const j=makeJob(d.binding,input),old=d.jobs.find(x=>x.job.id===j.id);if(old){if(old.job.payload_hash!==j.payload_hash)throw Error('Job ID payload mismatch');return old;}const entry={job:j,state:'pending',receipt:null};d.jobs.push(entry);store.save(d);return entry;});}
export async function exportBatch(store,limit=20){if(!Number.isInteger(limit)||limit<1||limit>100)fail();return store.lock(()=>{const d=store.read();if(d.role!=='cloud')fail();const jobs=d.jobs.filter(x=>!x.receipt).slice(0,limit).map(x=>x.job);const b={version:1,binding_hash:hash(d.binding),jobs};if(Buffer.byteLength(JSON.stringify(b))>4*1024*1024)fail();return b;});}
const pub=b=>Object.fromEntries(['remote_id','account_id','brand','server_sha256'].map(k=>[k,b[k]]));
export async function invoke(binding,job){localBinding(binding);const p=job.payload,args=['--disable-warning=ExperimentalWarning',binding.server];let body;
 if(job.operation==='receive'){args.push('inbox-page','--state-dir',binding.state_dir,'--limit',String(p.limit),'--show-text');if(p.cursor)args.push('--cursor',p.cursor);}
 else{args.push(job.operation,'--config',binding.config_ref,'--expected-app-id',binding.account_id,'--expected-brand',binding.brand,'--format',p.format,'--stdin','--idempotency-key',p.idempotency_key);if(job.operation==='reply')args.push('--message-id',p.reply_to);else args.push('--receive-id',p.destination.id,'--receive-id-type',p.destination.type);body=typeof p.body==='string'?p.body:JSON.stringify(p.body);}
 return new Promise((resolve,reject)=>{const env={...process.env};delete env.DEBUG;delete env.NODE_DEBUG;const child=spawn(process.execPath,args,{shell:false,stdio:['pipe','pipe','pipe'],env});let chunks=[],size=0,over=false;const timer=setTimeout(()=>child.kill('SIGKILL'),job.operation==='receive'?14000:74000);child.stdout.on('data',c=>{size+=c.length;if(size>4*1024*1024){over=true;child.kill('SIGKILL');}else chunks.push(c);});child.stderr.resume();child.stdin.on('error',()=>{});child.on('error',()=>{clearTimeout(timer);reject(Error('Local CLI unavailable'));});child.on('close',()=>{clearTimeout(timer);try{if(over)fail();resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(Error('Local CLI result unavailable'));}});child.stdin.end(body);});}
export function normalize(raw,j){if(j.operation==='receive'){if(raw?.protocol_version!==1||!Array.isArray(raw.messages)||raw.messages.length>j.payload.limit||typeof raw.next_cursor!=='string'||typeof raw.has_more!=='boolean')throw Error('Invalid receive page');for(const row of raw.messages)if(typeof row.cursor!=='string'||!row.message||typeof row.message!=='object')throw Error('Invalid receive row');return {status:'page',page:raw};}
 const key=j.payload.idempotency_key;if(raw?.idempotency_key!==key)return {status:'delivery_unknown',idempotency_key:key};if(raw.ok===true&&typeof raw.message_id==='string'&&raw.message_id.length&&raw.message_id.length<=256)return {status:'api_accepted',message_id:raw.message_id,idempotency_key:key};if(!['not_sent','api_error','delivery_unknown'].includes(raw.status))return {status:'delivery_unknown',idempotency_key:key};const r={status:raw.status,idempotency_key:key,retryable:false};for(const k of ['error_code','request_phase'])if(typeof raw[k]==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(raw[k]))r[k]=raw[k];for(const k of ['code','http_status','elapsed_ms'])if(Number.isSafeInteger(raw[k]))r[k]=raw[k];return r;}
export async function processBatch(store,batch,executor=invoke){if(batch?.version!==1||!Array.isArray(batch.jobs)||batch.jobs.length>100||Buffer.byteLength(JSON.stringify(batch))>4*1024*1024)fail();return store.lock(async()=>{const d=store.read();if(d.role!=='local'||batch.binding_hash!==hash(pub(d.binding)))throw Error('Local binding mismatch');for(const j of batch.jobs)validateJob(j,pub(d.binding));const receipts=[];
 for(const job of batch.jobs){let e=d.jobs.find(x=>x.job.id===job.id);if(e&&e.job.payload_hash!==job.payload_hash)throw Error('Job ID payload mismatch');if(e?.receipt){receipts.push(e.receipt);continue;}if(e?.state==='intent'&&job.operation!=='receive'){const receipt={job_id:job.id,payload_hash:job.payload_hash,binding_hash:job.binding_hash,result:{status:'delivery_unknown',idempotency_key:job.payload.idempotency_key},at:new Date().toISOString()};e.receipt=receipt;e.state='recorded';store.save(d);receipts.push(receipt);continue;}
 if(!e){e={job,state:'pending',receipt:null};d.jobs.push(e);}e.state='intent';store.save(d);let result;try{result=normalize(await executor(d.binding,job),job);}catch{result=job.operation==='receive'?{status:'receive_error'}:{status:'delivery_unknown',idempotency_key:job.payload.idempotency_key};}e.receipt={job_id:job.id,payload_hash:job.payload_hash,binding_hash:job.binding_hash,result,at:new Date().toISOString()};e.state='recorded';store.save(d);receipts.push(e.receipt);}
 return {version:1,binding_hash:batch.binding_hash,receipts};});}
export async function importReceipts(store,bundle){return store.lock(()=>{const d=store.read();if(d.role!=='cloud'||bundle?.version!==1||bundle.binding_hash!==hash(d.binding)||!Array.isArray(bundle.receipts)||bundle.receipts.length>100||Buffer.byteLength(JSON.stringify(bundle))>4*1024*1024)fail();for(const r of bundle.receipts){const e=d.jobs.find(x=>x.job.id===r.job_id);if(!e||r.payload_hash!==e.job.payload_hash||r.binding_hash!==e.job.binding_hash)throw Error('Unknown receipt binding');if(e.receipt&&hash(e.receipt)!==hash(r))throw Error('Receipt replay mismatch');const result=r.result;if(e.job.operation==='receive'){if(result.status==='page')normalize(result.page,e.job);else if(result.status!=='receive_error')fail();}else if(result.idempotency_key!==e.job.payload.idempotency_key||!['api_accepted','not_sent','api_error','delivery_unknown'].includes(result.status)||(result.status==='api_accepted'&&!result.message_id))fail();e.receipt=structuredClone(r);e.state='recorded';}store.save(d);return {imported:bundle.receipts.length};});}
export async function getJob(store,jobId){return store.lock(()=>{const e=store.read().jobs.find(x=>x.job.id===jobId);if(!e)throw Error('Unknown job');return e;});}
export async function awaitReceipt(store,jobId,signal,timeout=65000){const end=Date.now()+timeout;while(Date.now()<end){if(signal?.aborted)throw Error('Bridge wait aborted');const e=await getJob(store,jobId);if(e.receipt)return e.receipt.result;await delay(100);}throw Error('Remote receipt pending; reconcile without resending');}
