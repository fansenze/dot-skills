import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {taskDocument,userStatus,uiTime} from '../scripts/presentation.mjs';
import {render_list,render_task} from '../scripts/taskctl.mjs';
import {createConnector} from '../scripts/connectors/feishu.mjs';
import {sendResult} from '../scripts/connectors/contract.mjs';
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
