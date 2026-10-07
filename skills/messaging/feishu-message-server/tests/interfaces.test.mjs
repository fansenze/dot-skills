import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ROOT, fromMapping} from '../scripts/config.mjs';
import {Inbox, readInboxPage} from '../scripts/messages.mjs';
import {CAPABILITIES, formatContent} from '../scripts/formats.mjs';
import {createNetwork, createClient, sendMessage, addReaction} from '../scripts/transport.mjs';
const sample = i => ({app_id:'fixture-app',tenant_key:'fixture-tenant',event_id:'event-'+i,message_id:'message-'+i,text:'body-'+i,content:'private-'+i});
function fixture(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-interface-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }
const cli = args => spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',path.join(ROOT,'scripts/server.mjs'),...args],{encoding:'utf8',timeout:10000});

test('cursor reads all backlog, duplicates allocate no gaps, restart resumes exact checkpoint', t => {
  const file=path.join(fixture(t),'inbox.sqlite3'); let inbox=new Inbox(file);
  for(let i=0;i<1103;i++) { assert.equal(inbox.put(sample(i)),true); assert.equal(inbox.put(sample(i)),false); }
  inbox.close(); let cursor=null, rows=[];
  do { const page=readInboxPage(file,{cursor,limit:137,showText:true}); rows.push(...page.messages); cursor=page.next_cursor; if(!page.has_more) break; } while(true);
  assert.equal(rows.length,1103); assert.equal(rows[0].message.text,'body-0');
  inbox=new Inbox(file); inbox.put(sample(1103)); inbox.close();
  const next=readInboxPage(file,{cursor}); assert.equal(next.messages.length,1); assert.equal(next.messages[0].message.message_id,'message-1103');
  assert.equal(next.messages[0].message.text,undefined); assert.equal(next.messages[0].message.content,undefined);
  assert.equal(readInboxPage(file,{cursor:next.next_cursor}).messages.length,0);
});

test('cursor rejects rotation, truncation and deletion followed by new writes without recycling offsets', t => {
  const dir=fixture(t), file=path.join(dir,'inbox.sqlite3'); let inbox=new Inbox(file); inbox.put(sample(0)); inbox.put(sample(1)); inbox.close();
  const first=readInboxPage(file,{limit:1}), end=readInboxPage(file).next_cursor;
  let db=new DatabaseSync(file); db.exec('DELETE FROM messages WHERE rowid=2'); db.close();
  assert.throws(()=>readInboxPage(file,{cursor:first.next_cursor}),/gap/);
  inbox=new Inbox(file); inbox.put(sample(2)); inbox.close();
  assert.throws(()=>readInboxPage(file,{cursor:first.next_cursor}),/gap/);
  assert.equal(readInboxPage(file,{cursor:end}).messages[0].message.message_id,'message-2');
  const other=path.join(dir,'other.sqlite3'); new Inbox(other).close();
  assert.throws(()=>readInboxPage(other,{cursor:end}),/does not match/);
  assert.throws(()=>readInboxPage(path.join(dir,'missing.sqlite3')),/unavailable/);
});

test('legacy inbox metadata is migrated only by the receiver without changing message IDs', t => {
  const file=path.join(fixture(t),'inbox.sqlite3'), db=new DatabaseSync(file);
  db.exec('CREATE TABLE messages (app_id TEXT NOT NULL,tenant_key TEXT NOT NULL,event_id TEXT NOT NULL,message_id TEXT NOT NULL,message_json TEXT NOT NULL,PRIMARY KEY(app_id,tenant_key,message_id),UNIQUE(app_id,tenant_key,event_id))');
  db.prepare('INSERT INTO messages VALUES (?,?,?,?,?)').run('fixture-app','fixture-tenant','event-0','message-0',JSON.stringify(sample(0))); db.close();
  assert.throws(()=>readInboxPage(file),/read failed/); new Inbox(file).close();
  assert.equal(readInboxPage(file).messages[0].message.message_id,'message-0');
});

test('concurrent receiver processes preserve a contiguous durable cursor', async t => {
  const file=path.join(fixture(t),'inbox.sqlite3'); new Inbox(file).close();
  const code=`import {Inbox} from ${JSON.stringify(pathToFileURL(path.join(ROOT,'scripts/messages.mjs')).href)};const i=new Inbox(process.argv[1]);for(let n=0;n<30;n++)i.put({app_id:'fixture',tenant_key:'tenant',event_id:process.argv[2]+n,message_id:process.argv[2]+n});i.close();`;
  await Promise.all(['one','two','three','four'].map(prefix=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code,file,prefix],{stdio:['ignore','ignore','pipe']}); let err='';child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',status=>status===0?resolve():reject(new Error(err)));
  })));
  assert.equal(readInboxPage(file,{limit:1000}).messages.length,120);
});

test('capabilities and inbox-page require no credential file; binding mismatch stops before API use', t => {
  const dir=fixture(t), config=path.join(dir,'config.json');
  assert.deepEqual(JSON.parse(cli(['capabilities']).stdout),CAPABILITIES);
  new Inbox(path.join(dir,'messages.sqlite3')).close();
  const page=cli(['inbox-page','--state-dir',dir,'--config',path.join(dir,'absent-config')]);assert.equal(page.status,0,page.stderr);assert.equal(JSON.parse(page.stdout).messages.length,0);
  fs.writeFileSync(config,JSON.stringify({app_id:'fixture-account',app_secret:'SYNTHETIC-PRIVATE-SECRET'}));
  const mismatch=cli(['send','--config',config,'--expected-app-id','different-account','--receive-id','fixture-chat','--text','do not send','--idempotency-key','fixed-key']);
  assert.equal(mismatch.status,1); assert.equal(JSON.parse(mismatch.stdout).status,'not_sent'); assert.doesNotMatch(mismatch.stdout,/SYNTHETIC-PRIVATE/);
});

test('card and markdown use interactive create/reply payloads and unchanged idempotency IDs', async t => {
  const network=createNetwork();t.after(()=>network.close());const calls=[];
  network.httpInstance.defaults.adapter=async request=>{calls.push(request);return {data:request.url.includes('tenant_access_token')?{code:0,tenant_access_token:'fixture-token',expire:7200}:{code:0,data:{message_id:'fixture-result',thread_id:'thread-fixture',root_id:'root-fixture',parent_id:'parent-fixture'}},status:200,statusText:'OK',headers:{},config:request};};
  const client=createClient(fromMapping({app_id:'fixture-format',app_secret:'fixture-secret'}),network);
  const card={elements:[{tag:'div',text:{tag:'plain_text',content:'测试 | <at id=all>'}}]};
  assert.equal((await sendMessage(client,{receiveId:'fixture-chat',format:'card',body:card,idempotencyKey:'card-fixed'})).ok,true);
  const reply=await sendMessage(client,{messageId:'fixture-original',format:'markdown',body:'**Result**',idempotencyKey:'markdown-fixed',replyInThread:true});assert.equal(reply.ok,true);assert.equal(reply.thread_id,'thread-fixture');assert.equal(reply.root_id,'root-fixture');
  const outgoing=calls.filter(c=>c.url.includes('/im/v1/')).map(c=>JSON.parse(c.data));
  assert.equal(outgoing[0].msg_type,'interactive');assert.equal(outgoing[0].uuid,'card-fixed');assert.deepEqual(JSON.parse(outgoing[0].content),card);
  assert.equal(outgoing[1].uuid,'markdown-fixed');assert.equal(outgoing[1].reply_in_thread,true);assert.equal(JSON.parse(outgoing[1].content).body.elements[0].content,'**Result**');
  const before=calls.length;
  await assert.rejects(sendMessage(client,{receiveId:'fixture-chat',format:'markdown',body:'| A | B |',idempotencyKey:'unsupported'}),/tables/);
  await assert.rejects(sendMessage(client,{receiveId:'fixture-chat',format:'unknown',body:'hi',idempotencyKey:'unsupported'}),/Unsupported/);
  assert.equal(calls.length,before);assert.throws(()=>formatContent('card',{schema:'2.0',elements:[]}),/Card/);
});

test('Get reaction uses the official SDK endpoint and returns a reaction receipt without creating a message',async t=>{
  const network=createNetwork();t.after(()=>network.close());const calls=[];
  network.httpInstance.defaults.adapter=async request=>{calls.push(request);return {data:request.url.includes('tenant_access_token')?{code:0,tenant_access_token:'fixture-token',expire:7200}:{code:0,data:{reaction_id:'reaction-fixture'}},status:200,statusText:'OK',headers:{},config:request};};
  const client=createClient(fromMapping({app_id:'fixture-reactions',app_secret:'fixture-secret'}),network);
  const result=await addReaction(client,{messageId:'om_fixture',emojiType:'Get',idempotencyKey:'reaction-key'});
  assert.deepEqual(result,{ok:true,reaction_id:'reaction-fixture',idempotency_key:'reaction-key'});
  const [call]=calls.filter(r=>!r.url.includes('tenant_access_token'));
  assert.match(call.url,/\/im\/v1\/messages\/om_fixture\/reactions$/);assert.equal(call.method.toUpperCase(),'POST');
  assert.deepEqual(JSON.parse(call.data),{reaction_type:{emoji_type:'Get'}});
  const before=calls.length;
  for(const invalid of [{messageId:'../unrelated',emojiType:'Get'},{messageId:'om_fixture',emojiType:'Get\n'},{messageId:'om_fixture',emojiType:'Get',idempotencyKey:'bad key'}]) await assert.rejects(addReaction(client,invalid));
  assert.equal(calls.length,before);
});

test('reaction denial, malformed success, authentication failure and interrupted requests retain safe outcomes',async t=>{
  const network=createNetwork();t.after(()=>network.close());let mode='denied',effects=0;
  network.httpInstance.defaults.adapter=async request=>{
    if(request.url.includes('tenant_access_token')) return {data:{code:0,tenant_access_token:'fixture-token',expire:7200},status:200,statusText:'OK',headers:{},config:request};
    effects++;
    if(mode==='timeout')throw Object.assign(new Error('PRIVATE request body'),{code:'ETIMEDOUT',config:request});
    return {data:mode==='denied'?{code:99991672,msg:'PRIVATE diagnostic'}:{code:0,data:{message_id:'not-a-reaction'}},status:200,statusText:'OK',headers:{},config:request};
  };
  const client=createClient(fromMapping({app_id:'fixture-reaction-errors',app_secret:'fixture-secret'}),network),args={messageId:'om_fixture',emojiType:'Get',idempotencyKey:'reaction-key'};
  const denied=await addReaction(client,args);assert.equal(denied.status,'api_error');assert.equal(denied.code,99991672);assert.equal(denied.request_phase,'reaction');
  mode='malformed';assert.equal((await addReaction(client,args)).status,'delivery_unknown');
  mode='timeout';const timed=await addReaction(client,args);assert.equal(timed.status,'delivery_unknown');assert.equal(timed.request_phase,'reaction');assert.equal(timed.error_code,'ETIMEDOUT');
  assert.equal(effects,3);assert.doesNotMatch(JSON.stringify([denied,timed]),/PRIVATE/);
  network.httpInstance.defaults.adapter=async request=>({data:{code:99991663},status:200,statusText:'OK',headers:{},config:request});
  const cold=createClient(fromMapping({app_id:'fixture-reaction-cold',app_secret:'fixture-secret'}),network);
  const auth=await addReaction(cold,args);assert.equal(auth.status,'not_sent');assert.equal(auth.request_phase,'authentication');
});
