import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {run, parse_args} from '../scripts/taskctl.mjs';
import {createConnector} from '../scripts/connectors/feishu.mjs';
import {capabilities, sendResult} from '../scripts/connectors/contract.mjs';
import {responseDocument} from '../scripts/reply-presentation.mjs';
const ROOT=fileURLToPath(new URL('..',import.meta.url));
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const schema=json(path.join(ROOT,'references/connector-protocol.schema.json'));
function validate(value, definition) {
  if(definition.$ref) return validate(value,schema.$defs[definition.$ref.split('/').at(-1)]);
  if(definition.const!==undefined) assert.deepEqual(value,definition.const);
  if(definition.enum) assert.ok(definition.enum.includes(value));
  if(definition.type) { const actual=value===null?'null':Array.isArray(value)?'array':Number.isInteger(value)?'integer':typeof value;
    assert.ok([].concat(definition.type).includes(actual),JSON.stringify({value,type:definition.type})); }
  if(typeof value==='string') { if(definition.minLength) assert.ok(value.length>=definition.minLength); if(definition.maxLength) assert.ok(value.length<=definition.maxLength); if(definition.pattern) assert.match(value,new RegExp(definition.pattern)); }
  if(typeof value==='number') { if(definition.minimum!==undefined) assert.ok(value>=definition.minimum); if(definition.maximum!==undefined) assert.ok(value<=definition.maximum); }
  if(Array.isArray(value)) { if(definition.minItems!==undefined) assert.ok(value.length>=definition.minItems); if(definition.maxItems) assert.ok(value.length<=definition.maxItems);value.forEach(v=>validate(v,definition.items)); }
  if(value&&typeof value==='object'&&!Array.isArray(value)) {
    for(const key of definition.required??[]) assert.ok(Object.hasOwn(value,key),key);
    if(definition.additionalProperties===false) for(const key of Object.keys(value)) assert.ok(key in definition.properties,key);
    for(const [key,child] of Object.entries(definition.properties??{})) if(key in value) validate(value[key],child);
    for(const condition of definition.allOf??[]) if(Object.entries(condition.if.properties).every(([k,v])=>value[k]===v.const)) validate(value,condition.then);
  }
}
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'connector-examples-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}

test('documented CLI transcript executes with no credentials and normalized records satisfy the schemas', async t=>{
  const tmp=fixture(t),settings=path.join(tmp,'settings.json'),store=path.join(tmp,'store');fs.writeFileSync(settings,JSON.stringify({root:tmp}));
  const vars={ADAPTER:path.join(ROOT,'tests/fixtures/connector.mjs'),SETTINGS:settings};
  const examples=json(path.join(ROOT,'tests/interface-examples.json'));assert.equal(examples.protocol_version,1);
  for(const args of examples.commands) { const result=await run(parse_args(['--store',store,...args.map(v=>v.replace(/\$\{(\w+)\}/g,(_,k)=>vars[k]))]));
    if(args[0]==='render') { assert.match(result,/Title \| Status \| Summary/);assert.match(result,/Notifications pending/); }
    if(args[0]==='doctor') assert.equal(result.ok,true);
  }
  const data=json(path.join(store,'integration.json'));
  data.connections.forEach(c=>validate(capabilities(c.capabilities),schema.$defs.capabilities));
  for(const notice of data.outbox) { validate(notice.document,schema.$defs.document);validate(notice.receipt,schema.$defs.send_result);assert.equal(notice.state,'api_accepted'); }
  const calls=fs.readFileSync(path.join(tmp,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);calls.forEach(v=>validate(v,schema.$defs.message));
  for(const raw of [null,{status:'api_accepted',idempotency_key:'key',message_id:'bad\nID'},{status:'api_accepted',idempotency_key:'wrong',message_id:'id'}]) assert.equal(sendResult(raw,'key').status,'delivery_unknown');
});

test('Feishu renders native columns and explicit escaped Markdown/plain text without executing task content',t=>{
  const tmp=fixture(t),adapter=createConnector({server:path.join(ROOT,'scripts/taskctl.mjs'),config_ref:path.join(tmp,'unused-config'),state_dir:tmp,account_id:'fixture-app',brand:'feishu'});
  const doc={title:'Tasks',updated_at:'2026-01-01T00:00:00Z',columns:['Title','Status','Summary'],rows:[['用户 | <at id=all>','🚧','$(do-not-run) **private**']],details:['Failed: requested result not met']};
  const card=adapter.render('card',doc); assert.equal(card.elements[1].tag,'column_set');assert.equal(card.elements[1].columns.length,3);assert.equal(card.elements[1].columns[0].elements[0].text.tag,'plain_text');
  assert.equal(card.elements[1].columns[0].elements[0].text.content,doc.rows[0][0]);assert.match(adapter.render('markdown',doc),/&lt;at id=all&gt;/);assert.doesNotMatch(adapter.render('markdown',doc),/^\|/m);
  assert.match(adapter.render('text',doc),/用户 \|/);assert.throws(()=>adapter.render('html',doc),/Unsupported/);
});

test('bundled Feishu adapter uses the actual server capability and cursor commands when companion is available',async t=>{
  const candidate=process.env.FEISHU_SKILL_PATH??path.resolve(ROOT,'../../messaging/feishu-message-server');
  if(!fs.existsSync(path.join(candidate,'node_modules/@larksuiteoapi/node-sdk'))) return t.skip('Standalone task package: set FEISHU_SKILL_PATH to a dependency-installed companion for this cross-skill test');
  const tmp=fixture(t),code=`import {Inbox} from ${JSON.stringify(pathToFileURL(path.join(candidate,'scripts/messages.mjs')).href)};const inbox=new Inbox(process.argv[1]);inbox.put({app_id:'fixture-app',tenant_key:'fixture-tenant',event_id:'fixture-event',message_id:'fixture-message',chat_id:'fixture-chat',sender_open_id:'fixture-sender',sender_tenant_key:'fixture-tenant',message_type:'text',text:'@_user_1 /tasks list',bot_mention_keys:['@_user_1'],received_at:1700000000});inbox.close();`;
  const r=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code,path.join(tmp,'messages.sqlite3')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  const adapter=createConnector({server:path.join(candidate,'scripts/server.mjs'),config_ref:path.join(tmp,'no-config'),state_dir:tmp,account_id:'fixture-app',brand:'feishu'});
  validate(capabilities(await adapter.capabilities()),schema.$defs.capabilities);
  const page=await adapter.receive({cursor:null,limit:1});validate(page,schema.$defs.page);assert.equal(page.events[0].text,'/tasks list');assert.equal(page.events[0].sender_tenant_id,'fixture-tenant');
  assert.equal((await adapter.receive({cursor:page.next_cursor,limit:1})).events.length,0);
});

test('documented receive-only transcript queues run and verify without rendering or sending responses', async t => {
  const tmp=fixture(t),settings=path.join(tmp,'settings.json'),store=path.join(tmp,'store');
  const example=json(path.join(ROOT,'tests/interface-examples.json')).receive_only;
  fs.writeFileSync(settings,JSON.stringify({root:tmp,...example.settings}));
  fs.writeFileSync(path.join(tmp,'inbox.json'),JSON.stringify(example.incoming));
  const vars={ADAPTER:path.join(ROOT,'tests/fixtures/connector.mjs'),SETTINGS:settings};
  for(const args of example.commands) {
    const result=await run(parse_args(['--store',store,...args.map(v=>v.replace(/\$\{(\w+)\}/g,(_,k)=>vars[k]))]));
    if(args[0]==='ingest') assert.equal(result.ingested,2);
    if(args[0]==='doctor') assert.equal(result.ok,true);
  }
  const integration=json(path.join(store,'integration.json')),scheduler=json(path.join(store,'scheduler.json'));
  assert.deepEqual(integration.connections[0].capabilities.formats,[]);
  assert.equal(integration.connections[0].capabilities.send,false);assert.equal(integration.connections[0].capabilities.reply,false);
  assert.deepEqual(scheduler.requests.map(r=>r.spec.action),['execute','verify']);
  assert.equal(integration.outbox.length,0);assert.ok(!fs.existsSync(path.join(tmp,'calls.jsonl')));
});


test('document schema supports all response templates and still rejects unknown semantic fields',()=>{
 const responses=[
  {template:'ack',lead:'Received.'},
  {template:'list',lead:'No tasks in scope.',items:[],coverage:{shown:0,total:0}},
  {template:'detail',lead:'First line.\nSecond line.',sections:[{title:'Next',items:['Confirm scope']}],links:[{label:'Document',url:'https://example.com/report'}]},
  {template:'decision',lead:'Which scope?',options:[{label:'Current release',description:'Use the approved changes'}]},
  {template:'brief',lead:'Scope is still pending.',data_time:'2026-10-05T01:02:03Z',source:'Authorized ledger'}
 ];
 for(const response of responses){
  const doc=responseDocument(response,'2026-10-05T01:02:03Z');validate(doc,schema.$defs.document);
  assert.throws(()=>validate({...doc,response:{...response,unrecognized:true}},schema.$defs.document));
 }
 for(const response of [{template:'ack',lead:'Received.',title:'Forbidden title'},{template:'decision',lead:'Choose',options:[]},{template:'brief',lead:'Summary'}]){
  assert.throws(()=>validate(response,schema.$defs.response));
 }
});
