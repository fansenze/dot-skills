import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {selectTaskList} from '../scripts/task-list.mjs';
import {run,parse_args,Store} from '../scripts/taskctl.mjs';

test('filter precedes the ten-record limit; recent terminal records cannot crowd out active tasks',()=>{
  const active=Array.from({length:12},(_,i)=>({id:'task-'+String(i).padStart(2,'0'),status:['queued','executing','blocked','awaiting_verification'][i%4],updated_at:`2026-10-07T00:00:00.${String(i).padStart(6,'0')}Z`}));
  const terminal=['completed','failed','cancelled'].map(status=>({id:status,status,updated_at:'2026-10-08T00:00:00Z',notification_summary:'Uncertain',scheduling_summary:'Pending'}));
  const input=[...terminal,...active],before=structuredClone(input);
  assert.deepEqual(selectTaskList(input).map(t=>t.id),active.slice(2).reverse().map(t=>t.id));
  assert.deepEqual(input,before);
  assert.equal(selectTaskList(input,{all:true}).length,15);
  assert.deepEqual(selectTaskList(input,{status:'failed'}).map(t=>t.id),['failed']);
  assert.equal(selectTaskList([]).length,0);
  assert.equal(selectTaskList(active.slice(0,4)).length,4);
});

test('update ordering normalizes time zones and retains microseconds with a deterministic tie',()=>{
  const tasks=[
    {id:'task-a',status:'queued',updated_at:'2026-10-07T09:00:00.000001+08:00'},
    {id:'task-b',status:'queued',updated_at:'2026-10-07T01:00:00.000002Z'},
    {id:'task-c',status:'queued',updated_at:'2026-10-07T01:00:00.000001Z'}
  ];
  assert.deepEqual(selectTaskList(tasks).map(t=>t.id),['task-b','task-a','task-c']);
});

test('default CLI and bundle load only the selected active details; explicit history remains available',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-list-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'store'),call=(...args)=>run(parse_args(['--store',root,...args]));
  await call('init');
  for(let i=0;i<12;i++) await call('register','--id','task-'+String(i).padStart(2,'0'),'--title','Synthetic '+i,'--goal','Verified outcome');
  await call('register','--id','task-cancelled','--title','History','--goal','Cancelled work');
  await call('update','task-cancelled','--status','cancelled','--reason','Explicit cancellation');
  const list=await call('list');assert.equal(list.length,10);assert.equal(list[0].id,'task-11');assert.equal(list.at(-1).id,'task-02');
  assert.equal((await call('list','--all')).length,13);
  assert.deepEqual((await call('list','--status','cancelled')).map(t=>t.id),['task-cancelled']);
  // An unselected history file is never read by default listing/rendering.
  fs.writeFileSync(path.join(root,'tasks/task-cancelled/task.json'),'invalid unselected history');
  const output=path.join(dir,'bundle');
  assert.equal((await call('render','bundle','--output',output)).rendered,11);
  assert.equal(fs.readdirSync(path.join(output,'tasks')).length,10);
  assert.doesNotMatch(fs.readFileSync(path.join(output,'index.md'),'utf8'),/History|Synthetic 0 \|/);
  await assert.rejects(call('render','list','--all'));
  assert.equal(new Store(root).index().length,13,'selection does not delete history');
});
