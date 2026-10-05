import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResponse,responseDocument,renderResponse,responseFormat} from '../scripts/reply-presentation.mjs';

const time='2026-10-05T01:02:03Z';
const caps={formats:['text','markdown','card']};
const samples={
 ack:{template:'ack',lead:'收到，我先核对资料。'},
 list:{template:'list',title:'任务进展',lead:'有一项需要确认。',items:[{title:'发布资料',status:'排队中',summary:'等待范围确认',blocker:'缺少目标版本',next_action:'请确认版本',url:'https://example.com/release'}],coverage:{shown:1,total:3}},
 detail:{template:'detail',title:'发布资料',lead:'主体已完成。\n还需核对附件。',sections:[{title:'已完成',items:['整理正文','核对来源']},{title:'下一步',items:['确认附件']}],links:[{label:'查看资料',url:'https://example.com/release'}]},
 decision:{template:'decision',lead:'请选择发布范围。',options:[{label:'本周变更',description:'只整理已合并内容'},{label:'全部计划',description:'包含待审核内容'}]},
 brief:{template:'brief',title:'进展简报',lead:'资料仍待最终确认。',data_time:time,source:'已授权的任务台账',sections:[{title:'注意事项',items:['发布范围尚未确认']}]}
};
const stringContents=value=>{
 if(Array.isArray(value))return value.flatMap(stringContents);
 if(value&&typeof value==='object')return Object.entries(value).flatMap(([key,item])=>key==='content'&&typeof item==='string'?[item]:stringContents(item));
 return [];
};
const objects=value=>!value||typeof value!=='object'?[]:[value,...Object.values(value).flatMap(objects)];

test('all five response templates validate and retain multiline semantic content in documents',()=>{
 for(const response of Object.values(samples)){
  assert.doesNotThrow(()=>validateResponse(response));
  const doc=responseDocument(response,time);
  assert.deepEqual(doc.response,response);assert.equal(doc.updated_at,time);
  for(const key of ['columns','rows','details'])assert.ok(Array.isArray(doc[key]),key+' retains legacy adapter shape');
  for(const format of ['text','markdown','card']){
   const output=renderResponse(response,format);
   assert.equal(typeof output,format==='card'?'object':'string');
   assert.ok(format==='card'?JSON.stringify(output).length:output.length);
  }
 }
 assert.match(renderResponse(samples.detail,'text'),/主体已完成。\n还需核对附件。/);
});

test('list keeps zero, one, and twenty items and reports selected coverage without truncation',()=>{
 for(const count of [0,1,20]){
  const response={template:'list',lead:count?'当前任务如下。':'暂无任务。',items:Array.from({length:count},(_,i)=>({title:'任务 '+i,summary:'摘要 '+i})),coverage:{shown:count,total:count+4}};
  assert.doesNotThrow(()=>validateResponse(response));assert.deepEqual(responseDocument(response,time).response.items,response.items);
  const output=renderResponse(response,'text');for(const item of response.items)assert.ok(output.includes(item.title));
  assert.match(output,new RegExp(String(count+4)));
 }
 assert.throws(()=>validateResponse({...samples.list,items:Array.from({length:21},()=>({title:'任务'}))}));
 assert.throws(()=>validateResponse({...samples.list,coverage:{shown:1,total:0}}));
 assert.throws(()=>validateResponse({...samples.list,coverage:{shown:2,total:3}}));
});

test('template-specific requirements reject ambiguous or incomplete presentations',()=>{
 for(const response of [
  {template:'unknown',lead:'内容'},
  {template:'ack',lead:'第一行\n第二行'},
  {template:'ack',lead:'x'.repeat(301)},
  {template:'ack',lead:'收到',title:'不应另有标题'},
  {template:'ack',lead:'收到',items:[]},
  {template:'ack',lead:'收到',sections:[]},
  {template:'ack',lead:'收到',links:[]},
  {template:'ack',lead:'收到',options:[]},
  {template:'decision',lead:'选择一种方案'},
  {template:'decision',lead:'选择一种方案',options:[]},
  {template:'brief',lead:'摘要'},
  {...samples.brief,data_time:'yesterday'},
  {...samples.brief,data_time:'2026-02-30T01:02:03Z'},
  {...samples.brief,data_time:'2026-10-05T24:02:03Z'},
  {...samples.brief,source:''}
 ])assert.throws(()=>validateResponse(response),JSON.stringify(response));
 assert.doesNotThrow(()=>validateResponse({template:'ack',lead:'x'.repeat(300)}));
});

test('strict schema rejects unknown fields, unsafe controls, invalid nested values and oversized arrays',()=>{
 for(const response of [
  null,[],{}, {...samples.detail,unknown:'no'},
  {...samples.detail,title:'x'.repeat(161)}, {...samples.detail,lead:'x'.repeat(4001)},
  {...samples.detail,lead:'bad\u0000value'}, {...samples.detail,lead:'bad\u0007value'},
  {...samples.detail,lead:'bad\u007fvalue'},
  {...samples.detail,lead:'bad\u0085value'},
  {...samples.detail,lead:'bad\u2028value'},
  {...samples.detail,lead:'bad\u2029value'},
  {...samples.detail,lead:'bad\ud800value'},
  {...samples.detail,lead:'bad\udfffvalue'},
  {...samples.list,items:[{title:'任务',unknown:'no'}]},
  {...samples.detail,sections:[{title:'事项',items:[42]}]},
  {...samples.detail,sections:Array.from({length:9},()=>({title:'事项',items:['内容']}))},
  {...samples.detail,sections:[{title:'事项',items:Array.from({length:21},()=> '内容')}]},
  {...samples.detail,links:Array.from({length:11},()=>({label:'资料',url:'https://example.com'}))},
  {...samples.decision,options:Array.from({length:11},()=>({label:'选项',description:'说明'}))},
  {...samples.detail,format_override:{format:'html',authorization_ref:'verified-message'}},
  {...samples.detail,format_override:{format:'text'}},
  {...samples.detail,format_override:{format:'text',authorization_ref:''}},
  {...samples.detail,format_override:{format:'text',authorization_ref:'verified-message',destination:'other'}}
 ])assert.throws(()=>validateResponse(response));
 assert.doesNotThrow(()=>validateResponse({...samples.detail,lead:'第一行\n第二行\t说明'}));
});

test('response byte bound measures UTF-8 and never silently truncates oversized Chinese content',()=>{
 const make=letter=>({template:'detail',lead:'范围说明',sections:[{title:'详细内容',items:Array.from({length:20},()=>letter.repeat(600))}]});
 const ascii=make('a'), chinese=make('字');
 assert.ok(Buffer.byteLength(JSON.stringify(ascii))<24*1024);assert.ok(Buffer.byteLength(JSON.stringify(chinese))>24*1024);
 assert.doesNotThrow(()=>validateResponse(ascii));assert.throws(()=>validateResponse(chinese));
});

test('only HTTP and HTTPS link destinations are accepted in items and link lists',()=>{
 for(const url of ['https://example.com/report?a=1&b=2','http://example.com/report']){
  assert.doesNotThrow(()=>validateResponse({...samples.detail,links:[{label:'报告',url}]}));
 }
 for(const url of ['javascript:alert(1)','data:text/html,unsafe','file:///etc/passwd','ftp://example.com/report','/relative-path','not a URL','https://example.com/\nunsafe']){
  assert.throws(()=>validateResponse({...samples.detail,links:[{label:'报告',url}]}));
  assert.throws(()=>validateResponse({...samples.list,items:[{title:'任务',url}]}));
 }
});

test('plain content is preserved while Markdown and native cards cannot interpret injected markup',()=>{
 const attack='**bold** [forged](https://evil.example) <at user_id="all">all</at> <script>bad</script> `code` | cell';
 const response={template:'detail',title:attack,lead:attack,sections:[{title:'事项',items:[attack]}],links:[{label:'可信资料',url:'https://example.com/report'}]};
 const before=JSON.stringify(response), plain=renderResponse(response,'text'), markdown=renderResponse(response,'markdown'), card=renderResponse(response,'card');
 assert.equal(JSON.stringify(response),before,'render does not rewrite input');
 assert.ok(plain.includes(attack.replaceAll('<','‹').replaceAll('>','›')));
 assert.ok(!plain.includes('<at user_id="all">'));
 assert.ok(!markdown.includes('<at user_id="all">'));assert.ok(!markdown.includes('<script>'));assert.ok(!markdown.includes('[forged](https://evil.example)'));
 assert.ok(!markdown.includes('**bold**'));assert.ok(!markdown.includes('`code`'));
 assert.ok(stringContents(card).includes(attack));
 assert.ok(objects(card).every(row=>row.tag!=='markdown'&&row.tag!=='lark_md'));
 assert.ok(objects(card).some(row=>row.tag==='button'&&row.url==='https://example.com/report'));
});

test('format choice honors per-message authorization, supported capabilities and the existing route',()=>{
 const ackDoc=responseDocument(samples.ack,time), detailDoc=responseDocument(samples.detail,time);
 assert.equal(responseFormat(ackDoc,'card',caps),'text');
 assert.equal(responseFormat(ackDoc,'card',{formats:['card']}),'card');
 assert.equal(responseFormat(detailDoc,'card',caps),'card');
 assert.equal(responseFormat({title:'Legacy',columns:[],rows:[],details:[]},'markdown',caps),'markdown');
 for(const format of ['text','markdown','card']){
  const doc=responseDocument({...samples.detail,format_override:{format,authorization_ref:'verified-user-message'}},time);
  assert.equal(responseFormat(doc,'card',caps),format);
  assert.throws(()=>responseFormat(doc,'card',{formats:['other']}));
 }
 assert.equal(responseFormat(detailDoc,'card',caps),'card','one message does not change the next message format');
});


test('plain-text result link labels cannot emit provider mention markup',()=>{
 const attack='<at user_id="all">everyone</at>';
 for(const response of [
  {template:'detail',lead:'Reviewed result',links:[{label:attack,url:'https://example.com/report'}]},
  {template:'list',lead:'Reviewed task',items:[{title:attack,url:'https://example.com/report'}],coverage:{shown:1,total:1}}
 ]){
  const rendered=renderResponse(response,'text');assert.doesNotMatch(rendered,/<at user_id=/);assert.match(rendered,/‹at user_id=/);
 }
});


test('verified links preserve text and card URL fidelity while Markdown safely encodes delimiters',()=>{
 const url='https://example.com/report(part)?a=1&b=2';
 const response={template:'detail',lead:'Review A & B',links:[{label:'A & B',url}]};
 assert.ok(renderResponse(response,'text').includes(url));assert.ok(renderResponse(response,'text').includes('Review A & B'));
 assert.ok(objects(renderResponse(response,'card')).some(row=>row.tag==='button'&&row.url===url));
 assert.ok(renderResponse(response,'markdown').includes('(https://example.com/report%28part%29?a=1&b=2)'));
});


test('twenty mixed-status list items group by normalized status with per-page counts and explicit partial coverage',()=>{
 const statuses=['🕒 排队中','🚧 执行中','✅ 成功','❌ 失败','Pending','In progress','Succeeded','Failed','Needs review',undefined];
 const items=Array.from({length:20},(_,i)=>{
  let status=statuses[i%statuses.length];if(['✅ 成功','Succeeded'].includes(status))status+=' · 2026-10-05 09:'+String(i).padStart(2,'0')+':00';
  return {title:'Task '+String(i).padStart(2,'0'),...(status?{status}:{}),summary:'Verified fact '+i};
 });
 const response={template:'list',title:'Status overview',lead:'These are the twenty inspected records.',items,coverage:{shown:20,total:37}}, before=JSON.stringify(response);
 const labels=['排队中','执行中','成功','失败','Pending','In progress','Succeeded','Failed','Needs review','未标注状态'];
 for(const format of ['text','markdown','card']){
  const rendered=renderResponse(response,format), output=typeof rendered==='string'?rendered:stringContents(rendered).join('\n\n');
  let previous=-1;
  for(const [i,label] of labels.entries()){
   const heading=label+' · 2 项（本页）', position=output.indexOf(heading);
   assert.ok(position>previous,'groups follow first appearance: '+label+' in '+format);assert.equal(output.split(heading).length-1,1);
   const first=output.indexOf('Task '+String(i).padStart(2,'0')), second=output.indexOf('Task '+String(i+10).padStart(2,'0'));
   assert.ok(first>position&&second>first,'group preserves its two items: '+label);
   if(i<labels.length-1)assert.ok(second<output.indexOf(labels[i+1]+' · 2 项（本页）'));
   previous=position;
  }
  assert.ok(output.includes('仅显示 20/37 项，列表未完整展示。'));
  assert.ok(output.includes('✅ 成功 · 2026-10-05 09:02:00'));assert.ok(output.includes('✅ 成功 · 2026-10-05 09:12:00'));
  assert.ok(output.includes('Succeeded · 2026-10-05 09:06:00'));assert.ok(output.includes('Succeeded · 2026-10-05 09:16:00'));
 }
 assert.equal(JSON.stringify(response),before,'group rendering does not reorder semantic input');
});
