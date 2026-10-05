import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {taskDocument,taskResponseDocument,userStatus,uiTime} from '../scripts/presentation.mjs';
import {render_list,render_task} from '../scripts/taskctl.mjs';
import {createConnector} from '../scripts/connectors/feishu.mjs';
import {sendResult} from '../scripts/connectors/contract.mjs';
import {renderResponse} from '../scripts/reply-presentation.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/python-schema1/tasks/task-legacy/task.json',import.meta.url),'utf8'));
const config={stale_hours:24};
const template=name=>fs.readFileSync(new URL('../ui/'+name,import.meta.url),'utf8');

test('all internal states map to exactly four Chinese statuses and preserve blocked/cancelled explanations',()=>{
 const seen=new Set();
 for(const status of ['queued','executing','blocked','awaiting_verification','completed','failed','cancelled']){
  const task={...fixture,status,blocker:status==='blocked'?'缺少用户确认':'',completion:status==='completed'?{at:'2026-10-04T01:02:03Z',summary:'虚构结果已核对'}:null};
  seen.add(userStatus(task).split(' · ')[0].split(' ').slice(1).join(' '));
  const doc=taskDocument([task]);assert.equal(doc.title,task.title);assert.deepEqual(doc.rows,[]);assert.deepEqual(doc.columns,[]);assert.ok(doc.details[0].includes(task.id));assert.ok(!doc.details.includes(task.title));
  assert.doesNotMatch(doc.details.join('\n'),/awaiting_verification|executing/);
  if(status==='blocked'){assert.match(doc.details.join('\n'),/排队中/);assert.match(doc.details.join('\n'),/受阻，等待处理：缺少用户确认/);}
  if(status==='cancelled'){assert.match(doc.details.join('\n'),/失败/);assert.match(doc.details.join('\n'),/已取消，未完成/);}
 }
 assert.deepEqual([...seen].sort(),['排队中','执行中','成功','失败'].sort());
});
test('Shanghai seconds are shared by Markdown/card titles and actual completion timestamps',()=>{
 assert.equal(uiTime('2026-10-04T01:02:03.123456Z'),'2026-10-04 09:02:03');
 const task={...fixture,title:'虚构/演示任务',goal:'虚构/演示任务',summary:'虚构/演示任务',status:'completed',blocker:'',steps:[],checks:[],results:[],completion:{at:'2026-10-04T01:02:03Z',summary:'演示成果已核对'},updated_at:'2026-10-04T01:03:04Z'};
 const now=new Date('2026-10-04T01:04:05Z');
 const detail=render_task(task,config,template('task-detail.md'),now,'zh');
 assert.match(detail.split('\n')[0],/^# 虚构\/演示任务 · <sub>2026-10-04 09:03:04<\/sub>$/);assert.equal(detail.split(task.title).length-1,1);assert.match(detail,/ID: task-legacy/);assert.match(detail,/成功 · 2026-10-04 09:02:03/);
 const list=render_list([task],config,template('list.md'),false,now,false,'zh');assert.match(list.split('\n')[0],/任务列表.*2026-10-04 09:04:05/);
 const adapter=createConnector({server:fileURLToPath(new URL('../scripts/taskctl.mjs',import.meta.url)),config_ref:'/tmp/unused-fixture',state_dir:'/tmp',account_id:'fixture',brand:'feishu'});
 const card=adapter.render('card',taskDocument([task]));assert.equal(card.header.title.content,task.title+' · 2026-10-04 09:03:04');assert.ok(card.elements.every(e=>e.tag!=='column_set'));
});
test('receipt thread identifiers are bounded context, never coerced or confused with acceptance',()=>{
 const receipt=sendResult({status:'api_accepted',idempotency_key:'key',message_id:'message',thread_id:'thread',root_id:'root',parent_id:'parent'},'key');
 assert.equal(receipt.thread_id,'thread');assert.equal(receipt.parent_id,'parent');
 for(const invalid of ['bad\nID',{},'x'.repeat(257)])assert.equal(sendResult({...receipt,thread_id:invalid},'key').thread_id,undefined);
 assert.equal(sendResult({...receipt,idempotency_key:'other'},'key').status,'delivery_unknown');
});

test('failed cards preserve the outcome reason and useful next action despite an older summary',()=>{
 const task={...fixture,title:'虚构/演示失败任务',goal:'核对演示结果',summary:'之前正在整理资料',status:'failed',blocker:'',checks:[],results:[],next_action:'修正格式后重新提交',events:[...fixture.events,{kind:'status',at:'2026-10-04T01:02:03Z',text:'executing -> failed: 请求格式校验失败'}]};
 const detail=taskDocument([task],'zh');
 assert.match(detail.details.join('\n'),/❌ 失败/);
 assert.match(detail.details.join('\n'),/请求格式校验失败/);
 assert.match(detail.details.join('\n'),/下一步：修正格式后重新提交/);
 const list=taskDocument([task],'zh',false);
 assert.match(list.rows[0][2],/请求格式校验失败/);
});


test('structured task-list projection keeps legacy rows and makes the twenty-item limit explicit',()=>{
 for(const count of [0,1,21]){
  const tasks=Array.from({length:count},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'Reviewed summary',blocker:'',checks:[],results:[]}));
  const doc=taskResponseDocument(tasks,'en',false);
  assert.equal(doc.rows.length,count);assert.equal(doc.response.template,'list');assert.equal(doc.response.items.length,Math.min(count,20));
  assert.deepEqual(doc.response.coverage,{shown:Math.min(count,20),total:count});
 }
});

test('oversized task projections explicitly mark clipped content and preserve accurate item coverage',()=>{
 const tasks=Array.from({length:20},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'字'.repeat(2000),blocker:'',checks:[],results:[]}));
 const doc=taskResponseDocument(tasks,'en',false);
 assert.equal(doc.rows.length,20);assert.ok(doc.response.items.length>0&&doc.response.items.length<20);
 assert.deepEqual(doc.response.coverage,{shown:doc.response.items.length,total:20});
 assert.ok(doc.response.items.every(item=>item.summary.includes('partial; inspect task details')));
 assert.ok(Buffer.byteLength(JSON.stringify(doc.response))<=24*1024);
});

test('structured detail preserves blockers, current failed checks, next action and safe result links',()=>{
 const task={...fixture,title:'Release materials',summary:'An older summary',status:'blocked',blocker:'Confirm scope',next_action:'Choose the target version',
  checks:[{name:'Old failure',outcome:'fail',evidence:'Stale',work_revision:fixture.work_revision-1},...Array.from({length:4},(_,i)=>({name:'Current check '+i,outcome:'fail',evidence:'Required evidence '+i,work_revision:fixture.work_revision}))],
  results:[{label:'Verified document',url:'https://example.com/report'},{label:'Unsafe link',url:'javascript:alert(1)'}]};
 const doc=taskResponseDocument([task],'en'),response=doc.response, sections=JSON.stringify(response.sections);
 assert.equal(response.template,'detail');assert.deepEqual(doc.columns,[]);assert.deepEqual(doc.rows,[]);
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
 assert.deepEqual(response.coverage,{shown:1,total:1});
});


test('task-list render expansion stays bounded with explicit coverage in every format',()=>{
 const tasks=Array.from({length:20},(_,i)=>({...fixture,id:'task-'+i,title:'Task '+i,summary:'*'.repeat(900),blocker:'',checks:[],results:[]}));
 const response=taskResponseDocument(tasks,'en',false).response;
 assert.ok(response.items.length>0&&response.items.length<20);assert.deepEqual(response.coverage,{shown:response.items.length,total:20});
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
