/** Synthetic task-conversation adapter. No credentials, sockets, or external services. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createConnector(settings) {
  const read = (name, fallback) => { try { return fs.readFileSync(path.join(settings.root,name),'utf8'); } catch { return fallback; } };
  const append = (name, value) => {
    const fd=fs.openSync(path.join(settings.root,name),'a',0o600);
    try { fs.writeSync(fd,JSON.stringify(value)+'\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  async function reply(message) {
    const mode=read('mode','accepted').trim(); append('calls.jsonl',message);
    if(mode==='not_sent')return {status:'not_sent',idempotency_key:message.idempotency_key,retryable:true,error_code:'synthetic-no-send'};
    if(mode==='api_error')return {status:'api_error',idempotency_key:message.idempotency_key,http_status:400};
    append('effects.jsonl',message);
    const effects=read('effects.jsonl','').trim().split('\n').length;
    if(mode==='crash-after-effect'||(mode==='crash-on-second-effect'&&effects===2))process.kill(process.pid,'SIGKILL');
    if(mode==='throw-after-effect')throw new Error('PRIVATE-SYNTHETIC-DIAGNOSTIC-MUST-NOT-LEAK');
    if(mode==='malformed')return {status:'api_accepted',idempotency_key:'wrong-key',message_id:'untrusted-id'};
    const message_id='synthetic-provider-'+crypto.createHash('sha256').update(message.idempotency_key).digest('hex').slice(0,24);
    return {status:'api_accepted',idempotency_key:message.idempotency_key,message_id,parent_id:message.reply_to,root_id:message.reply_to,thread_id:'synthetic-thread'};
  }
  return {
    capabilities:()=>({presentation:'feishu',protocol_version:1,name:'conversation-fixture',formats:settings.formats??['text','markdown','card'],send:true,reply:settings.reply??true,receive:true,durable_cursor:true}),
    send:reply,reply:settings.reply===false?undefined:reply,
    receive:async({cursor,limit})=>{const rows=JSON.parse(read('inbox.json','[]')),start=cursor===null?0:Number(cursor),events=rows.slice(start,start+limit).map((e,i)=>({...e,cursor:String(start+i+1)}));return {events,next_cursor:String(start+events.length),has_more:start+events.length<rows.length};},
  };
}
