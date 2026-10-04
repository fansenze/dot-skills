import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractReadableContent} from '../scripts/content.mjs';
import {extractMessage, Inbox, readInboxPage, readInbox} from '../scripts/messages.mjs';

const body = {title:'演示请求',content:[[{tag:'text',text:'请检查 '},{tag:'a',text:'资料',href:'https://example.com/ref?q=1'}],[{tag:'text',text:'保留换行'}]]};
const expected = '演示请求\n请检查 资料 (https://example.com/ref?q=1)\n保留换行';
for (const [name, content] of Object.entries({direct:body,post:{post:body},locale:{zh_cn:body,en_us:{title:'Do not repeat',content:[]}},wrapped:{post:{zh_cn:body}}})) {
  test(`post ${name} wrapper extracts one text projection`,()=>{
    for(const raw of [content,JSON.stringify(content)]) assert.deepEqual(extractReadableContent({message_type:'post',content:raw}),{text:expected,text_source:'content'});
  });
}
test('content_v2 wins once; malformed or empty versions fall back without duplicating languages',()=>{
  const v2={content:[[{tag:'md',text:'**request**'},{tag:'code_block',text:'$(never-execute)'},{tag:'at',user_name:'@_bot'}]]};
  const both={message_type:'post',content:JSON.stringify(body),content_v2:JSON.stringify(v2)};
  assert.deepEqual(extractReadableContent(both),{text:'**request**$(never-execute)@_bot',text_source:'content_v2'});
  for(const raw of ['not-json',{}, {content:[]}, {content:[42]}]) assert.equal(extractReadableContent({...both,content_v2:raw}).text,expected);
});
test('links stay inert, unknown nodes are marked, malformed/oversized and non-post cards fail closed',()=>{
  const content={content:[[{tag:'a',text:'unsafe',href:'javascript:alert(1)'},{tag:'img',image_key:'not-fetched'},{tag:'unknown',text:'hidden instruction'}]]};
  const result=extractReadableContent({message_type:'post',content});
  assert.equal(result.text_omitted,true);assert.equal(result.text.trim(),'unsafe');
  for(const value of ['bad-json',{content:[{}]},{content:[[{tag:'text',text:'x'.repeat(8001)}]]},{content:[[{tag:'text',text:'bad\u0000control'}]]}]) assert.deepEqual(extractReadableContent({message_type:'post',content:value}),{});
  assert.deepEqual(extractReadableContent({message_type:'interactive',content:body}),{});
  assert.deepEqual(extractReadableContent({message_type:'image',content:body}),{});
  assert.deepEqual(extractReadableContent({message_type:'post',content:{content:[[{tag:'img',image_key:'unused'}]]}}),{});
});
test('receiver stores post identity/time/raw variants once; old rows gain projection only on private read',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'post-inbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const config={app_id:'app-fixture',bot_open_id:'bot-fixture'};
  const payload={header:{event_type:'im.message.receive_v1',event_id:'event-fixture',tenant_key:'tenant-fixture'},event:{
    sender:{sender_id:{open_id:'sender-fixture'},tenant_key:'tenant-fixture'},message:{message_id:'message-fixture',chat_id:'chat-fixture',chat_type:'p2p',message_type:'post',create_time:'1700000000000',root_id:'root-fixture',content:JSON.stringify({post:{zh_cn:body}}),content_v2:JSON.stringify(body)}}};
  const record=extractMessage(payload,config).message;
  assert.equal(record.text,expected);assert.equal(record.message_type,'post');assert.equal(record.message_created_ms,'1700000000000');assert.equal(record.sender_open_id,'sender-fixture');assert.equal(record.root_id,'root-fixture');
  assert.equal(record.content,payload.event.message.content);assert.equal(record.content_v2,payload.event.message.content_v2);
  const file=path.join(dir,'inbox.sqlite3'), inbox=new Inbox(file);
  const old={...record};delete old.text;delete old.text_source;
  assert.equal(inbox.put(old),true);assert.equal(inbox.put(record),false);assert.equal(inbox.put({...record,message_id:'changed-message'}),false);inbox.close();
  const page=readInboxPage(file,{showText:true});assert.equal(page.messages.length,1);assert.equal(page.messages[0].message.text,expected);
  const publicMessage=readInboxPage(file).messages[0].message;for(const key of ['text','content','content_v2']) assert.equal(publicMessage[key],undefined);
  assert.equal(readInbox(file,10,false)[0].content_v2,undefined);
  assert.equal(readInboxPage(file,{cursor:page.next_cursor}).messages.length,0);
  payload.event.message.chat_type='group';assert.equal(extractMessage(payload,config).reason,'outside_receive_scope');
  payload.event.message.mentions=[{id:{open_id:'bot-fixture'},key:'@_bot'}];assert.equal(extractMessage(payload,config).message.text,expected);
});
