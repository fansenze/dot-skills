import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {taskResponseDocument,taskStatusLabel,uiTime} from '../scripts/presentation.mjs';
import {render_list,render_task} from '../scripts/taskctl.mjs';
import {sendResult} from '../scripts/connectors/contract.mjs';
import {renderResponse,renderConnectorDocument} from '../scripts/reply-presentation.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/python-schema1/tasks/task-legacy/task.json',import.meta.url),'utf8'));
const config={stale_hours:24};
const template=name=>fs.readFileSync(new URL('../ui/'+name,import.meta.url),'utf8');

test('task projections use readable statuses and preserve blockers',()=>{
 const seen=new Set();
 for(const status of ['queued','executing','blocked','awaiting_verification','completed','failed','cancelled']){
  const task={...fixture,status,blocker:status==='blocked'?'缺少用户确认':'',completion:status==='completed'?{at:'2026-10-04T01:02:03Z',summary:'虚构结果已核对'}:null};
  seen.add(taskStatusLabel(task));
  const doc=taskResponseDocument([task]);assert.equal(doc.response.title,task.title);assert.equal(doc.response.status,taskStatusLabel(task));
  assert.doesNotMatch(JSON.stringify(doc.response),/awaiting_verification|executing/);
  if(status==='blocked')assert.match(JSON.stringify(doc.response.sections),/缺少用户确认/);
 }
 assert.deepEqual([...seen].sort(),['排队中','执行中','受阻','待验收','已完成','失败','已取消'].sort());
});
test('Markdown and native card footers use actual completion time',()=>{
 assert.equal(uiTime('2026-10-04T01:02:03.123456Z'),'2026-10-04 09:02:03');
 const task={...fixture,title:'虚构/演示任务',goal:'虚构/演示任务',summary:'虚构/演示任务',status:'completed',blocker:'',steps:[],checks:[],results:[],completion:{at:'2026-10-04T01:02:03Z',summary:'演示成果已核对'},updated_at:'2026-10-04T01:03:04Z'};
 const now=new Date('2026-10-04T01:04:05Z');
 const detail=render_task(task,config,template('task-detail.md'),now,'zh');
 assert.equal(detail.split('\n')[0],'# 虚构/演示任务');assert.equal(detail.split(task.title).length-1,1);assert.doesNotMatch(detail,/ID: task-legacy/);assert.match(detail,/已完成/);assert.match(detail,/完成于：2026-10-04 09:02:03/);assert.doesNotMatch(detail,/09:03:04/);
 const list=render_list([task],config,template('list.md'),false,now,true,'zh');assert.match(list,/核对于：2026-10-04 09:04:05/);assert.ok(list.lastIndexOf('09:04:05')>list.indexOf(task.title));
 const card=renderConnectorDocument({presentation:'feishu'},'card',taskResponseDocument([task]));assert.equal(card.header.title.content,task.title);
 assert.match(JSON.stringify(card),/完成于：2026-10-04 09:02:03/);assert.doesNotMatch(JSON.stringify(card),/09:03:04/);
});
test('receipt thread identifiers are bounded context, never coerced or confused with acceptance',()=>{
 const receipt=sendResult({status:'api_accepted',idempotency_key:'key',message_id:'message',thread_id:'thread',root_id:'root',parent_id:'parent'},'key');
 assert.equal(receipt.thread_id,'thread');assert.equal(receipt.parent_id,'parent');
 for(const invalid of ['bad\nID',{},'x'.repeat(257)])assert.equal(sendResult({...receipt,thread_id:invalid},'key').thread_id,undefined);
 assert.equal(sendResult({...receipt,idempotency_key:'other'},'key').status,'delivery_unknown');
});

test('failed cards preserve the outcome reason and useful next action despite an older summary',()=>{
 const task={...fixture,title:'虚构/演示失败任务',goal:'核对演示结果',summary:'之前正在整理资料',status:'failed',blocker:'',checks:[],results:[],next_action:'修正格式后重新提交',events:[...fixture.events,{kind:'status',at:'2026-10-04T01:02:03Z',text:'executing -> failed: 请求格式校验失败'}]};
 const detail=taskResponseDocument([task],'zh').response;
 assert.equal(detail.status,'失败');assert.match(JSON.stringify(detail.sections),/请求格式校验失败/);
 assert.ok(detail.sections.some(s=>s.title==='下一步'&&s.items.includes('修正格式后重新提交')));
 const list=taskResponseDocument([task],'zh',false);
 assert.equal(list.response.items.length,0);
});


test('structured task-list projection bounds semantic items to ten active records',()=>{
 for(const count of [0,1,21]){
  const tasks=Array.from({length:count},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'Reviewed summary',blocker:'',checks:[],results:[]}));
  const doc=taskResponseDocument(tasks,'en',false);
  assert.equal(doc.response.template,'list');assert.equal(doc.response.items.length,Math.min(count,10));
  assert.deepEqual(doc.response.coverage,{shown:Math.min(count,10),total:null});
 }
});

test('oversized task projections explicitly mark clipped content and preserve accurate item coverage',()=>{
 const tasks=Array.from({length:20},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'字'.repeat(2000),blocker:'',checks:[],results:[]}));
 const doc=taskResponseDocument(tasks,'en',false);
 assert.ok(doc.response.items.length>0&&doc.response.items.length<=10);
 assert.deepEqual(doc.response.coverage,{shown:doc.response.items.length,total:null});
 assert.ok(doc.response.items.every(item=>item.summary.includes('partial; inspect task details')));
 assert.ok(Buffer.byteLength(JSON.stringify(doc.response))<=24*1024);
});

test('structured detail preserves blockers, current failed checks, next action and safe result links',()=>{
 const task={...fixture,title:'Release materials',summary:'An older summary',status:'blocked',blocker:'Confirm scope',next_action:'Choose the target version',
  checks:[{name:'Old failure',outcome:'fail',evidence:'Stale',work_revision:fixture.work_revision-1},...Array.from({length:4},(_,i)=>({name:'Current check '+i,outcome:'fail',evidence:'Required evidence '+i,work_revision:fixture.work_revision}))],
  results:[{label:'Verified document',url:'https://example.com/report'},{label:'Unsafe link',url:'javascript:alert(1)'}]};
 const doc=taskResponseDocument([task],'en'),response=doc.response, sections=JSON.stringify(response.sections);
 assert.equal(response.template,'detail');assert.deepEqual(Object.keys(doc).sort(),['response','updated_at']);
 assert.match(sections,/Confirm scope/);assert.match(sections,/Choose the target version/);assert.match(sections,/Current check 0/);assert.doesNotMatch(sections,/Old failure/);
 assert.match(sections,/More failed checks omitted/);assert.match(sections,/1 result links omitted/);
 assert.deepEqual(response.links,[{label:'Verified document',url:'https://example.com/report'}]);
 const completed=taskResponseDocument([{...task,status:'completed',blocker:'',checks:[],completion:{at:'2026-10-05T01:02:03Z',summary:'Actual verified outcome'}}],'en');
 assert.equal(completed.response.lead,'Actual verified outcome');
});


test('blank task summaries preserve their list item and omit only the optional empty field',()=>{
 const task={...fixture,title:'Empty summary task',status:'queued',summary:'',next_action:'',blocker:'',events:[],checks:[],results:[]};
 const response=taskResponseDocument([task],'en',false).response;
 assert.equal(response.items.length,1);assert.equal(response.items[0].title,task.title);assert.equal(response.items[0].summary,undefined);
 assert.deepEqual(response.coverage,{shown:1,total:null});
});


test('task-list render expansion stays bounded with explicit coverage in every format',()=>{
 const tasks=Array.from({length:20},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'*'.repeat(900),blocker:'',checks:[],results:[]}));
 const response=taskResponseDocument(tasks,'en',false).response;
 assert.ok(response.items.length>0&&response.items.length<=10);assert.deepEqual(response.coverage,{shown:response.items.length,total:null});
 for(const format of ['text','markdown','card'])assert.ok(Buffer.byteLength(JSON.stringify(renderResponse(response,format)))<=28000);
});

test('automatic clipping of supplementary characters never leaves malformed Unicode',()=>{
 const task={...fixture,title:'🚀'.repeat(100),summary:'🚀'.repeat(800),blocker:'',checks:[],results:[]};
 const list=taskResponseDocument([task],'en',false).response,detail=taskResponseDocument([task],'en',true).response;
 for(const response of [list,detail]){
  const walk=value=>{if(typeof value==='string')assert.ok(value.isWellFormed());else if(value&&typeof value==='object')Object.values(value).forEach(walk);};walk(response);
 }
 assert.match(list.items[0].summary,/partial/);assert.match(detail.title,/partial/);
});

test('verbose detail enrichment stays deliverable with visible blockers, failed checks and partial notices',()=>{
 for(const letter of ['字','*']){
  const task={...fixture,title:'Synthetic verbose task',status:'failed',summary:letter.repeat(2000),goal:letter.repeat(4000),blocker:letter.repeat(1000),next_action:letter.repeat(1000),
   events:[{kind:'status',text:'executing -> failed: '+letter.repeat(1000)}],
   steps:Array.from({length:8},()=>({title:letter.repeat(1000),state:'skipped',evidence:letter.repeat(1000)})),
   checks:Array.from({length:5},(_,i)=>({name:'Current failure '+i,outcome:'fail',evidence:letter.repeat(1000),work_revision:fixture.work_revision})),
   results:Array.from({length:10},(_,i)=>({label:'Verified result '+i,url:'https://example.com/'+letter.replace('*','x').repeat(600)+i}))};
  const response=taskResponseDocument([task],'en',true).response;
  for(const format of ['text','markdown','card'])assert.ok(Buffer.byteLength(JSON.stringify(renderResponse(response,format)))<=28000);
  assert.match(JSON.stringify(response.sections),/Blocked|Current failure 0|More failed checks omitted|More steps omitted|partial/);
  assert.equal(response.status,'Failed');
 }
});
