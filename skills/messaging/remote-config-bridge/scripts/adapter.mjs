/** Local-module connector: platform transport is performed by the active dot. */
import crypto from 'node:crypto';
import {Store,enqueue,awaitReceipt,hash} from './core.mjs';
// Provider envelope IDs are context hints, never sender identity or authorization.
// Omit malformed optional metadata instead of truncating or inventing identifiers.
const replyContext = message => Object.fromEntries(['parent_id', 'root_id', 'thread_id']
  .filter(key => typeof message[key] === 'string' && /^[^\s\x00-\x1f\x7f]{1,256}$/u.test(message[key]))
  .map(key => [key, message[key]]));

const clock = new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const uiTime = value => clock.format(new Date(value));
export function createConnector(settings){if(!settings||Object.keys(settings).some(k=>!['store','authorization_ref'].includes(k))||typeof settings.store!=='string'||!settings.store.startsWith('/')||typeof settings.authorization_ref!=='string')throw Error('Bridge settings need store and authorization_ref');const store=new Store(settings.store);
 const capabilities=()=>({protocol_version:1,name:'remote-config-bridge',formats:['text','markdown','card'],send:true,reply:true,receive:true,durable_cursor:true});
 const render=(format,d)=>{if(!['text','markdown','card'].includes(format))throw Error('Unsupported format');if(format!=='card')return [d.title+' · '+uiTime(d.updated_at),...d.rows.map(r=>r.join(' · ')),...d.details].join('\n');const plain=t=>({tag:'div',text:{tag:'plain_text',content:String(t)}}),row=r=>({tag:'column_set',columns:r.map(t=>({tag:'column',width:'weighted',weight:1,elements:[plain(t)]}))});return {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:d.title+' · '+uiTime(d.updated_at)}},elements:[...(d.columns.length&&d.rows.length?[row(d.columns)]:[]),...d.rows.map(row),...d.details.map(plain)]};};
 async function dispatch(operation,payload,signal){const jobId=operation==='receive'?'receive-'+crypto.randomUUID():'send-'+hash(payload.idempotency_key).slice(0,48);const job={id:jobId,operation,payload,authorization_ref:settings.authorization_ref};await enqueue(store,job);return awaitReceipt(store,jobId,signal);}
 return {capabilities,render,send:(m,{signal}={})=>dispatch('send',m,signal),reply:(m,{signal}={})=>dispatch('reply',m,signal),async receive({cursor=null,limit=100,signal}={}){const result=await dispatch('receive',{cursor,limit},signal);if(result.status!=='page')throw Error('Remote receive unavailable; preserve checkpoint');const p=result.page;return {next_cursor:p.next_cursor,has_more:p.has_more,events:p.messages.map(({cursor,message:m})=>{let text=m.text;for(const key of m.bot_mention_keys??[])if(typeof text==='string')text=text.replace(key,'').trim();return {cursor,...replyContext(m),event_id:m.event_id,message_id:m.message_id,account_id:m.app_id,tenant_id:m.tenant_key,sender_tenant_id:m.sender_tenant_key,sender_id:m.sender_open_id,destination_id:m.chat_id,type:m.message_type,...(m.text_source?{text_source:m.text_source}:{}),...(m.text_omitted?{text_omitted:true}:{}),received_at:new Date(m.received_at*1000).toISOString(),occurred_at:/^\d{13}$/.test(m.message_created_ms)?new Date(Number(m.message_created_ms)).toISOString():null,text};})};}};
}
