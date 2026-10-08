import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {describeUpload,RESOURCE_LIMITS} from '../scripts/resources.mjs';
import {uploadResource,createClient,createNetwork} from '../scripts/transport.mjs';
import {fromMapping} from '../scripts/config.mjs';
import {startResident,residentRequest,runtimeIdentity,uploadReceipt} from '../scripts/resident.mjs';
import {sendResidentMessage} from '../scripts/server.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-resource-')), cleanup={};t.after(async()=>{await cleanup.close?.();fs.rmSync(root,{recursive:true,force:true});});
  const dir=path.join(root,'authorized');fs.mkdirSync(dir);
  const bytes=Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.from([0,255,128,13,10]),Buffer.alloc(150000,42)]),file=path.join(dir,'report.pdf');fs.writeFileSync(file,bytes);
  const descriptor=describeUpload({filePath:file,allowedRoot:dir,kind:'file'});
  return {root,dir,file,bytes,descriptor,cleanup};
}
function sdk(t,respond) {
  const network=createNetwork();t.after(()=>network.close());const calls=[];
  network.httpInstance.defaults.adapter=async req=>{calls.push(req);return {data:req.url.includes('tenant_access_token')?{code:0,tenant_access_token:'synthetic-token',expire:7200}:await respond(req),status:200,statusText:'OK',headers:{},config:req};};
  return {client:createClient(fromMapping({app_id:'cli_resource_fixture',app_secret:'synthetic-secret'}),network),calls};
}
test('authorized paths, binary hashes, zero/oversize files and changed bytes fail closed',t=>{
  const f=fixture(t);assert.equal(f.descriptor.sha256,hash(f.bytes));assert.equal(f.descriptor.size,f.bytes.length);
  const outside=path.join(f.root,'outside.pdf');fs.writeFileSync(outside,'%PDF-outside');
  const linked=path.join(f.dir,'linked.pdf');fs.symlinkSync(outside,linked);
  for(const filePath of [outside,linked,f.dir])assert.throws(()=>describeUpload({filePath,allowedRoot:f.dir,kind:'file'}));
  fs.mkdirSync(path.join(f.dir,'linked-dir'));fs.rmdirSync(path.join(f.dir,'linked-dir'));fs.symlinkSync(f.root,path.join(f.dir,'linked-dir'));
  assert.throws(()=>describeUpload({filePath:path.join(f.dir,'linked-dir','outside.pdf'),allowedRoot:f.dir,kind:'file'}));
  for(const [kind,extension] of [['image','png'],['file','pdf']]){
    const filePath=path.join(f.dir,'sized.'+extension);fs.writeFileSync(filePath,'');assert.throws(()=>describeUpload({filePath,allowedRoot:f.dir,kind}));
    fs.writeFileSync(filePath,'%PDF-');fs.truncateSync(filePath,RESOURCE_LIMITS[kind]);assert.equal(describeUpload({filePath,allowedRoot:f.dir,kind}).size,RESOURCE_LIMITS[kind]);
    fs.truncateSync(filePath,RESOURCE_LIMITS[kind]+1);assert.throws(()=>describeUpload({filePath,allowedRoot:f.dir,kind}));
  }
  fs.writeFileSync(f.file,'%PDF-changed');assert.throws(()=>describeUpload(f.descriptor));
});
test('real SDK upload unwrap, multipart binary, JSON message content and original reply thread',async t=>{
  const f=fixture(t), requests=[];
  const {client}=sdk(t,req=>{requests.push(req);return {code:0,data:req.url.endsWith('/files')?{file_key:'file_fixture'}:req.url.endsWith('/images')?{image_key:'img_fixture'}:{message_id:'om_uploaded',root_id:'om_root'}};});
  const identity={app_id:'cli_resource_fixture',brand:'feishu',runtime:runtimeIdentity()},directory=path.join(f.root,'resident');
  let service=await startResident({directory,identity,handler:(op,args)=>op==='upload'?uploadResource(client,args,identity):sendResidentMessage(client,args,directory,identity)});
  f.cleanup.close=()=>service.close();
  const uploadArgs={descriptor:f.descriptor,idempotencyKey:'upload-file'};
  const request=(operation,args)=>residentRequest({directory,identity,operation,args});
  const uploaded=await request('upload',uploadArgs);assert.equal(uploaded.status,'uploaded');assert.equal(uploaded.resource.sha256,hash(f.bytes));assert.equal(uploaded.resource.file_key,'file_fixture');
  const multipart=requests[0].data.getBuffer();assert.ok(multipart.includes(f.bytes));assert.match(multipart.toString('latin1'),/name="file_type"\r\n\r\npdf/);assert.ok(multipart.includes(Buffer.from('report.pdf')));
  const imagePath=path.join(f.dir,'picture.png');fs.writeFileSync(imagePath,Buffer.from([137,80,78,71,13,10,26,10,0,255]));
  assert.equal((await request('upload',{descriptor:describeUpload({filePath:imagePath,allowedRoot:f.dir,kind:'image'}),idempotencyKey:'upload-image'})).resource.image_key,'img_fixture');
  assert.match(requests[1].data.getBuffer().toString('latin1'),/name="image_type"\r\n\r\nmessage/);
  const args={format:'file',resourceId:'upload-file',messageId:'om_root',replyInThread:true,idempotencyKey:'send-file'};
  const receipt=await request('reply',args);assert.equal(receipt.message_id,'om_uploaded');
  const durable=JSON.parse(fs.readFileSync(path.join(directory,'receipts',hash('send-file')+'.json')));assert.equal(durable.resource_id,'upload-file');assert.equal(durable.identity.brand,'feishu');assert.equal(durable.target.message_id,'om_root');assert.equal(durable.result.message_id,'om_uploaded');
  const data=JSON.parse(requests[2].data);assert.equal(data.msg_type,'file');assert.equal(data.content,JSON.stringify({file_key:'file_fixture'}));assert.equal(data.reply_in_thread,true);assert.equal(data.uuid,'send-file');
  await request('send',{format:'image',resourceId:'upload-image',receiveId:'oc_fixture',idempotencyKey:'send-image'});
  assert.equal(JSON.parse(requests[3].data).content,JSON.stringify({image_key:'img_fixture'}));
  fs.unlinkSync(f.file);await service.close();service=await startResident({directory,identity,handler:()=>{throw new Error('must replay');}});
  assert.deepEqual(await request('reply',args),receipt);assert.deepEqual(await request('upload-status',{resourceId:'upload-file'}),uploaded);assert.equal(requests.length,4);
  await assert.rejects(request('reply',{...args,messageId:'om_other'}),/idempotency-conflict/);
  assert.throws(()=>uploadReceipt(directory,'upload-file',{...identity,brand:'lark'}),/binding/);
  assert.equal((await sendResidentMessage(client,{...args,resourceId:'missing'},directory,identity)).status,'not_sent');assert.equal(requests.length,4);
});
test('SDK upload business errors, malformed success and timeouts never invent resources',async t=>{
  const f=fixture(t);
  for(const [name,response,expected] of [['denied',{code:99991672,msg:'PRIVATE'},'api_error'],['missing',{code:0,data:{}},'upload_unknown'],['bad',{data:{file_key:'file_unverified'}},'upload_unknown']]){
    const {client}=sdk(t,()=>response);const r=await uploadResource(client,{descriptor:f.descriptor,idempotencyKey:name},{app_id:'fixture',brand:'feishu'});assert.equal(r.status,expected);assert.doesNotMatch(JSON.stringify(r),/PRIVATE|file_unverified/);if(name==='denied')assert.equal(r.code,99991672);
  }
  const client={im:{file:{create:async()=>{throw Object.assign(new Error('PRIVATE'),{code:'ETIMEDOUT'});}}}};
  assert.equal((await uploadResource(client,{descriptor:f.descriptor,idempotencyKey:'timeout'},{app_id:'fixture',brand:'feishu'})).status,'upload_unknown');
  fs.writeFileSync(f.file,'%PDF-changed');let called=false;
  assert.equal((await uploadResource({im:{file:{create:()=>{called=true;}}}},{descriptor:f.descriptor,idempotencyKey:'changed'},{})).status,'not_uploaded');assert.equal(called,false);
});
test('CLI attachment commands keep binary out of the small resident request and replay unknown uploads',async t=>{
  const f=fixture(t),identity={app_id:'cli_resource_fixture',brand:'feishu',runtime:runtimeIdentity()},config=path.join(f.root,'synthetic.json'),directory=path.join(f.root,'resident');
  fs.writeFileSync(config,JSON.stringify({app_id:identity.app_id,app_secret:'synthetic-secret'}));let calls=0;
  const service=await startResident({directory,identity,handler:(op,args)=>{calls++;assert.equal(op,'upload');assert.ok(Buffer.byteLength(JSON.stringify(args))<2000);return {ok:false,status:'upload_unknown',idempotency_key:args.idempotencyKey};}});f.cleanup.close=()=>service.close();
  const script=fileURLToPath(new URL('../scripts/server.mjs',import.meta.url));
  const call=async args=>{try{return JSON.parse((await promisify(execFile)(process.execPath,[script,...args])).stdout);}catch(e){return JSON.parse(e.stdout);}};
  const args=['upload','--path',f.file,'--allowed-root',f.dir,'--kind','file','--config',config,'--resident-dir',directory,'--idempotency-key','cli-upload'];
  assert.equal((await call(args)).status,'upload_unknown');assert.equal((await call(args)).status,'upload_unknown');assert.equal(calls,1);
  assert.equal((await call(['upload-status','--config',config,'--resident-dir',directory,'--resource-id','cli-upload'])).status,'upload_unknown');assert.equal(calls,1);
});
