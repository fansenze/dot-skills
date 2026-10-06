/** Task-scoped conversation ledger. Platform tools belong to the active assistant. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import {readIntegration} from './integration.mjs';
import {grantCovers} from './message-inbox.mjs';
import {grantForMessage} from './received-intake.mjs';
import {digest, requireText, loadConnector, bounded, sendResult, ConnectorError} from './connectors/contract.mjs';
import {responseDocument, validateResponse, renderResponse} from './reply-presentation.mjs';

export const CONVERSATION_OPTIONS = {
  'conversation-bind':['file'], 'conversation-show':[], 'conversation-disable':[],
  'conversation-publish':['file'], 'conversation-input':['file'], 'conversation-answer':['file'], 'conversation-consume':['file'],
  'conversation-next':['channel','consumer','lease-ms'], 'conversation-begin':['token'],
  'conversation-receipt':['token','file'], 'conversation-resolve':['file'],
  'conversation-deliver':['consumer','lease-ms','limit'],
};
export const CONVERSATION_IDS = Object.keys(CONVERSATION_OPTIONS).filter(k=>!['conversation-next','conversation-deliver'].includes(k));
const fail = message => { throw new ConnectorError(message); };
const stamp = () => new Date().toISOString();
const encode = v => JSON.stringify(v,null,2)+'\n';
const identifier = v => requireText(v,'conversation identifier',256);
const object = (v, keys) => { if (!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).some(k=>!keys.includes(k))) fail('Invalid conversation input fields'); return v; };
const text = v => {
  if (typeof v!=='string' || !v.trim() || v.length>4000 || !v.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(v)) fail('Invalid sanitized conversation text');
  // Defense in depth only; the active assistant must remove all secrets before input.
  if (/(?:-----BEGIN .*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16})\b|(?:password|access[_ -]?token|api[_ -]?key|client[_ -]?secret)\s*[:=]\s*\S+)/i.test(v)) fail('Potential secret: redact before recording');
  return v;
};
const reviewed = v => { if(v.privacy!=='reviewed' || v.audience!=='shared') fail('Only reviewed shared task content may enter the conversation'); };
const number = (v, fallback, max) => { const n=v===undefined?fallback:Number(v); if(!Number.isSafeInteger(n)||n<1||n>max)fail('Invalid conversation count or revision'); return n; };
const empty = () => ({schema_version:1,bindings:[],messages:[],questions:[],deliveries:[],answers:[]});
export function readConversations(store) {
  const p=store.path('conversations.json'); if(!fs.existsSync(p))return empty();
  let d; try { d=JSON.parse(fs.readFileSync(p,'utf8')); } catch {fail('Invalid conversation ledger; preserve for recovery');}
  if(d.schema_version!==1)fail('Unsupported conversation schema');
  for(const key of ['bindings','messages','questions','deliveries','answers']) {
    if(!Array.isArray(d[key]) || d[key].some(r=>!r || typeof r.id!=='string') || new Set(d[key].map(r=>r.id)).size!==d[key].length)fail('Invalid conversation records');
  }
  for(const b of d.bindings) if(b.id!==b.task_id || !Array.isArray(b.channels) || b.channels.some(c=>!['dot','feishu'].includes(c)) || typeof b.enabled!=='boolean')fail('Invalid conversation binding');
  for(const m of d.messages) if(!d.bindings.some(b=>b.id===m.task_id) || typeof m.text!=='string'||!['user','assistant'].includes(m.role)||(m.role==='user')!==(m.kind==='user_message'))fail('Invalid canonical message');
  for(const n of d.deliveries) if(!d.messages.some(m=>m.id===n.message_id && m.task_id===n.task_id && m.role==='assistant') || !['pending','claimed','sending','api_accepted','not_sent','api_error','delivery_unknown','cancelled'].includes(n.state) || !['dot','feishu'].includes(n.channel) || (['claimed','sending'].includes(n.state)&&!n.lease))fail('Invalid conversation delivery');
  for(const q of d.questions) if(!d.bindings.some(b=>b.id===q.task_id)||!Number.isSafeInteger(q.revision)||q.revision<1||!['pending','answered','consumed'].includes(q.state))fail('Invalid pending question');
  return d;
}
const pin = (g,c) => digest({grant:g,connection:c.binding});
function active(store,b) {
  if(!b?.enabled)fail('Task conversation is unbound or disabled');
  store.get(b.task_id);
  const i=readIntegration(store),policy=i.grants.find(g=>g.id===b.feishu.grant_id),evidence=i.inbox.find(r=>r.id===b.verification_ref);
  if(policy?.all_senders && !evidence)fail('Task conversation origin is unavailable');
  const g=grantForMessage(policy,evidence),c=i.connections.find(c=>c.id===g?.connector);
  if(!g?.enabled || !c?.enabled || !grantCovers(i,g,b.task_id) || pin(g,c)!==b.policy_pin)fail('Conversation authority changed or disabled; review before dispatch');
  return {g,c};
}
/** A verified original-topic match only; never infer by title, recency or text. */
export function conversationContext(store, entry) {
  const d=readConversations(store), refs=new Set([entry.envelope?.message_id,entry.envelope?.parent_id,entry.envelope?.root_id,entry.envelope?.thread_id].filter(Boolean));
  const matches=d.bindings.filter(b=>b.enabled&&b.feishu.grant_id===entry.grant_id && (refs.has(b.feishu.root_id)||d.deliveries.some(n=>n.task_id===b.task_id&&n.channel==='feishu'&&n.receipt?.status==='api_accepted'&&refs.has(n.receipt.message_id))));
  const current=matches.filter(b=>{try{const {g}=active(store,b);return !g.all_senders || (entry.connector===g.connector && entry.envelope.account_id===g.account && entry.envelope.tenant_id===g.tenant && entry.envelope.sender_id===g.sender && entry.envelope.destination_id===g.destination);}catch{return false;}});
  return {total_matches:current.length,matches:current.slice(0,20).map(b=>{const questions=d.questions.filter(q=>q.task_id===b.task_id),messages=d.messages.filter(m=>m.task_id===b.task_id);return {task_id:b.task_id,root_id:b.feishu.root_id,questions:questions.slice(-20).map(({consumptions,...q})=>({...q,consumption_count:consumptions?.length??0})),total_questions:questions.length,messages:messages.slice(-20),total_messages:messages.length};}),coverage:'at most 20 tasks, last 20 questions/messages each; counts expose partial context; conversation-show retrieves one full task ledger'};
}
export function ownsConversationRoute(store, taskId, policy) {
  const b=readConversations(store).bindings.find(b=>b.id===taskId&&b.enabled&&b.channels.includes('feishu'));if(!b)return false;
  try {const {g}=active(store,b);return g.connector===policy.connector && g.account===policy.account && g.destination===policy.destination && (!policy.all_senders || (g.tenant===policy.tenant && g.sender===policy.sender)) && (policy.destination_type??'chat_id')==='chat_id';}catch{return false;}
}
export function canonicalDecision(store, entry, decision, taskId) {
  const d=readConversations(store), matches=conversationContext(store,entry).matches;
  const b=d.bindings.find(b=>b.id===(taskId??(matches.length===1?matches[0].task_id:null))&&b.enabled);
  if(!b) {if(decision.canonical_message_id)fail('Canonical reply requires an active bound task');return false;}
  const {g}=active(store,b);
  if(g.all_senders && (entry.connector!==g.connector || entry.envelope.account_id!==g.account || entry.envelope.tenant_id!==g.tenant || entry.envelope.sender_id!==g.sender || entry.envelope.destination_id!==g.destination)) {
    if(decision.canonical_message_id)fail('Canonical reply belongs to another conversation');
    return false;
  }
  if(matches.length>1 || (matches.length===1&&matches[0].task_id!==b.id))fail('Ambiguous task conversation reply');
  const input=d.answers.find(a=>a.task_id===b.id&&a.channel==='feishu'&&a.evidence_ref===entry.id&&a.provider_message_id===entry.envelope.message_id);
  if(!input)fail('Record the reviewed task input with conversation-input before its canonical reply');
  const m=d.messages.find(m=>m.id===decision.canonical_message_id&&m.task_id===b.id);
  if(!m || m.sequence<=input.sequence || !['text','question','question_update','blocked','completed'].includes(m.kind) || m.text!==(decision.response?.lead??decision.reply) || (decision.response&&digest(m.response)!==digest(decision.response)))fail('Bound task reply requires its matching canonical_message_id; publish once first');
  return true;
}
export function conversationCompletionWrites(store,task,previous) {
  if(!previous||task.status!=='completed'||previous.status==='completed')return {};
  const d=readConversations(store),b=d.bindings.find(b=>b.id===task.id&&b.enabled);if(!b)return {};
  try{active(store,b);}catch{return {};}
  const id='task-completion-'+digest([task.id,task.work_revision]).slice(0,40);if(d.messages.some(m=>m.id===id))return {};
  text(task.completion.summary);
  message(d,b,{id,kind:'completed',text:task.completion.summary,format:'text',privacy:'reviewed',audience:'shared',completion_work_revision:task.work_revision});
  return {'conversations.json':encode(d)};
}
function message(d,b,m,channels=b.channels) {
  if(d.messages.some(x=>x.id===m.id))fail('Canonical message ID already exists');
  const role=m.kind==='user_message'?'user':'assistant';
  if(role!=='assistant'&&channels.length)fail('Only assistant messages may create outbound deliveries');
  const row={...m,role,task_id:b.task_id,created_at:stamp(),sequence:d.messages.length+1}; d.messages.push(row);
  for(const channel of channels) {
    if(!b.channels.includes(channel))continue;
    const id='chat-delivery-'+digest([row.id,channel]).slice(0,40);
    d.deliveries.push({id,message_id:row.id,task_id:b.task_id,channel,state:'pending',lease:null,attempts:0,receipt:null,root_id:b[channel].root_id,created_at:row.created_at});
  }
  return row;
}
function recover(d) {
  for(const n of d.deliveries) if(n.lease && Date.parse(n.lease.until)<=Date.now()) {
    if(n.state==='sending') {n.state='delivery_unknown';n.receipt={status:'delivery_unknown',idempotency_key:n.id,error_code:'sender-interrupted',retryable:false};}
    else if(n.state==='claimed')n.state='pending';
    n.lease=null;
  }
}
function invalidate(d,q) {
  for(const n of d.deliveries) {
    const m=d.messages.find(m=>m.id===n.message_id);
    if(m.question_id===q.id && m.question_revision===q.revision && ['pending','claimed','not_sent'].includes(n.state)){n.state='cancelled';n.lease=null;}
  }
}
function sanitizeFile(file) {
  identifier(file); const s=fs.statSync(file); if(!s.isFile()||s.size>32000)fail('Conversation file must be a bounded JSON file');
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('Invalid conversation JSON file');}
}
export function createConversations({store}) {
  const save=d=>store.commit({'conversations.json':encode(d)});
  const locked=fn=>store.locked(()=>{store.config();const d=readConversations(store);recover(d);return fn(d);});
  const binding=(d,id)=>{const b=d.bindings.find(b=>b.id===id);active(store,b);return b;};
  const delivery=(d,id,token)=>{const n=d.deliveries.find(n=>n.id===id);if(!n)fail('Unknown conversation delivery');binding(d,n.task_id);if(!n.lease||n.lease.token!==token||Date.parse(n.lease.until)<=Date.now())fail('Stale conversation lease');return n;};
  function view(d,b) {
    return {binding:b,task:store.get(b.task_id),messages:d.messages.filter(m=>m.task_id===b.task_id),questions:d.questions.filter(q=>q.task_id===b.task_id),deliveries:d.deliveries.filter(n=>n.task_id===b.task_id),answers:d.answers.filter(a=>a.task_id===b.task_id)};
  }
  function bind(d,id,v) {
    object(v,['authorization_ref','verification_ref','dot','feishu','channels']); store.get(id);
    identifier(v.authorization_ref);identifier(v.verification_ref);
    object(v.dot,['conversation_id','sender_id','root_id']);object(v.feishu,['grant_id','root_id']);
    for(const value of [...Object.values(v.dot),...Object.values(v.feishu)])identifier(value);
    for(const k of ['conversation_id','sender_id','root_id'])identifier(v.dot[k]);for(const k of ['grant_id','root_id'])identifier(v.feishu[k]);
    if(!Array.isArray(v.channels)||!v.channels.includes('feishu')||new Set(v.channels).size!==v.channels.length||v.channels.some(c=>!['dot','feishu'].includes(c)))fail('Explicit channel scope required');
    const i=readIntegration(store),policy=i.grants.find(g=>g.id===v.feishu.grant_id),c=i.connections.find(c=>c.id===policy?.connector);
    if(!policy?.enabled||policy.mode!=='agent'||!c?.enabled||!c.capabilities.reply)fail('An enabled scoped agent grant and reply connector are required');
    const evidence=i.inbox.find(r=>r.id===v.verification_ref&&r.grant_id===policy.id&&r.binding===c.binding&&r.task_id===id&&r.decision&&['recorded','done'].includes(r.status));
    const g=grantForMessage(policy,evidence);
    if(!grantCovers(i,g,id))fail('An enabled scoped agent grant and reply connector are required');
    if(!evidence || (evidence.envelope.root_id??evidence.envelope.message_id)!==v.feishu.root_id)fail('Binding root requires recorded task-associated inbox provenance');
    if(i.outbox.some(n=>n.route.account_id===g.account&&n.route.destination.id===g.destination&&(n.task_id===id||n.event_id==='received:'+evidence.id)&&!['api_accepted','cancelled'].includes(n.state)))fail('Settle legacy task replies before binding; uncertain sends require reconciliation');
    const b={id,task_id:id,...v,policy_pin:pin(g,c),enabled:true};const prior=d.bindings.find(x=>x.id===id);
    if(prior){if(!prior.enabled||digest({...prior,created_at:undefined})!==digest(b))fail('Binding is immutable or disabled; do not silently migrate');return prior;}
    b.created_at=stamp();d.bindings.push(b);save(d);return b;
  }
  function publish(d,id,v) {
    const b=binding(d,id);object(v,['id','kind','text','privacy','audience','format','question_id','question_revision','permission_class','response']);
    identifier(v.id);reviewed(v);text(v.text);
    if(v.response!==undefined){validateResponse(v.response);if(v.response.lead!==v.text||v.response.format_override)fail('Response must use canonical text and the explicit message format');const scan=x=>{if(typeof x==='string')text(x);else if(x&&typeof x==='object')Object.values(x).forEach(scan);};scan(v.response);}
    if(!['text','question','question_update','blocked','completed'].includes(v.kind))fail('Unsupported conversation kind; native controls are excluded');
    if(!['text','markdown','card'].includes(v.format))fail('Choose a per-message format');
    if(v.permission_class!==undefined&&v.permission_class!=='ordinary_text')fail('Native approvals cannot be mirrored');
    const prior=d.messages.find(m=>m.id===v.id);
    if(prior){if(prior.input_digest!==digest(v)||prior.task_id!==id)fail('Canonical ID conflicts with different content');return prior;}
    let q;
    if(['question','question_update'].includes(v.kind)) {
      identifier(v.question_id);number(v.question_revision,null,1e9);q=d.questions.find(q=>q.id===v.question_id);
      if(v.kind==='question') {if(q||v.question_revision!==1)fail('New question needs unique ID and revision 1');q={id:v.question_id,task_id:id,revision:1,state:'pending',answer_id:null,consumed:null};d.questions.push(q);}
      else {if(!q||q.task_id!==id||v.question_revision!==q.revision+1)fail('Question revision conflict');invalidate(d,q);q.revision++;q.state='pending';q.answer_id=null;q.consumed=null;}
      q.message_id=v.id;q.permission_class=v.permission_class??'ordinary_text';q.updated_at=stamp();
    } else if(v.question_id!==undefined||v.question_revision!==undefined)fail('Question metadata requires a question message');
    if(v.kind==='completed'){const task=store.get(id);if(task.status!=='completed')fail('Completion message requires verified completed task');if(d.messages.some(m=>m.task_id===id&&m.completion_work_revision===task.work_revision))fail('Completion already has a canonical message; use that ID rather than publishing again');}
    const row=message(d,b,{...v,input_digest:digest(v)});save(d);return row;
  }
  function answer(d,id,v,requiresQuestion=true) {
    const b=binding(d,id),{g}=active(store,b);
    object(v,['id','channel','provider_message_id','identity','occurred_at','question_id','question_revision','in_reply_to','text','privacy','audience','evidence_ref','redacted']);
    for(const k of ['id','provider_message_id','in_reply_to','evidence_ref'])identifier(v[k]);reviewed(v);text(v.text);
    if(requiresQuestion&&!v.question_id)fail('Question reference required; use conversation-input for ordinary messages');
    if(v.question_id!==undefined)identifier(v.question_id);
    if(!b.channels.includes(v.channel))fail('Answer channel is outside task scope');
    const expected=v.channel==='dot'?{conversation_id:b.dot.conversation_id,sender_id:b.dot.sender_id}:{account_id:g.account,tenant_id:g.tenant,sender_id:g.sender,destination_id:g.destination};
    if(digest(v.identity)!==digest(expected))fail('Answer identity does not match verified binding');
    const time=Date.parse(v.occurred_at);if(typeof v.occurred_at!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(v.occurred_at)||!Number.isFinite(time))fail('Input needs a valid source timestamp');
    if(v.redacted!==undefined&&typeof v.redacted!=='boolean')fail('Invalid redaction flag');
    const origin=digest([v.channel,v.identity,v.provider_message_id]);const prior=d.answers.find(a=>a.origin===origin||a.id===v.id);
    if(prior){if(prior.input_digest!==digest(v)||prior.task_id!==id)fail('Inbound ID conflicts with prior content');return {...prior,duplicate:true};}
    const q=v.question_id===undefined?null:d.questions.find(q=>q.id===v.question_id&&q.task_id===id);
    if(v.question_id!==undefined&&!q)fail('Unknown task question; resolve association first');
    if(q)number(v.question_revision,null,1e9);else if(v.question_revision!==undefined)fail('Question revision needs its question ID');
    const questionMessage=q?d.messages.find(m=>m.question_id===q.id&&m.question_revision===v.question_revision):null;
    const sent=q?d.deliveries.find(n=>n.channel===v.channel&&n.message_id===questionMessage?.id&&n.receipt?.status==='api_accepted'):null;
    if(q&&(!sent||![questionMessage.id,sent.receipt.message_id].includes(v.in_reply_to)))fail('Question reference requires its accepted channel delivery');
    if(!q&&v.in_reply_to!==b[v.channel].root_id&&!d.deliveries.some(n=>n.task_id===id&&n.channel===v.channel&&n.receipt?.status==='api_accepted'&&n.receipt.message_id===v.in_reply_to))fail('Input needs a verified task-topic reference');
    if(v.channel==='feishu') {
      const r=readIntegration(store).inbox.find(r=>r.id===v.evidence_ref&&r.grant_id===g.id&&r.envelope?.message_id===v.provider_message_id);
      if(r&&!v.redacted&&r.envelope.text!==v.text)fail('Input text must match the stored message; mark sanitized redactions explicitly');
      const exactReply=r&&sent&&r.envelope.parent_id===sent.receipt.message_id;
      const topic=r&&(r.envelope.root_id===b.feishu.root_id||r.envelope.parent_id===b.feishu.root_id);
      if(!r||!['pending','claimed','recorded','done'].includes(r.status)||Date.parse(r.envelope.received_at)<Date.parse(b.created_at)||(r.envelope.occurred_at??r.envelope.received_at)!==v.occurred_at||!Object.entries(v.identity).every(([k,value])=>r.envelope[k]===value)||!exactReply&&!topic)fail('Feishu input requires stored verified incoming envelope and topic correlation');
    }
    const a={...v,task_id:id,origin,input_digest:digest(v),received_at:stamp(),outcome:'appended',receive_sequence:d.answers.length+1};
    d.answers.push(a);
    // Different provider messages always append, including identical text and corrections.
    // References provide context, not votes or automatic approval interpretation.
    if(q){q.answer_id=a.id;q.state='answered';q.consumed=null;q.updated_at=stamp();}
    const row=message(d,b,{id:'user-message-'+digest([id,a.origin]).slice(0,40),kind:'user_message',text:a.text,format:'text',...(q?{question_id:q.id,question_revision:v.question_revision}:{}),input_id:a.id,redacted:Boolean(v.redacted)},[]);
    a.canonical_message_id=row.id;a.sequence=row.sequence;
    save(d);return a;
  }
  async function next(args) {
    if(!['dot','feishu'].includes(args.channel))fail('Choose dot or feishu');identifier(args.consumer);
    const ms=number(args.lease_ms,120000,3600000);
    return locked(d=>{
      for(const n of d.deliveries.filter(n=>n.channel===args.channel&&n.state==='pending')) {
        const b=d.bindings.find(b=>b.id===n.task_id);try{active(store,b);}catch{continue;}
        // Preserve per-task order; unresolved sends require reconciliation before catch-up.
        if(d.deliveries.some(x=>x.task_id===n.task_id&&x.channel===n.channel&&d.deliveries.indexOf(x)<d.deliveries.indexOf(n)&&!['api_accepted','cancelled'].includes(x.state)))continue;
        n.state='claimed';n.lease={token:crypto.randomUUID(),consumer:args.consumer,until:new Date(Date.now()+ms).toISOString()};
        const canonical=d.messages.find(m=>m.id===n.message_id);
        save(d);return {...n,message:canonical,delivery_text:canonical.response?renderResponse(canonical.response,'text'):canonical.text,destination:args.channel==='dot'?structuredClone(b.dot):{grant_id:b.feishu.grant_id,root_id:b.feishu.root_id},adapter:args.channel==='dot'?'active_assistant_platform_tool':'configured_connector'};
      }
      save(d);return null;
    });
  }
  async function begin(id,token) {return locked(d=>{const n=delivery(d,id,token);if(n.state!=='claimed')fail('Send intent already exists; reconcile, never resend');n.state='sending';n.attempts++;n.started_at=stamp();save(d);return {...n,proceed:true,message:d.messages.find(m=>m.id===n.message_id)};});}
  async function receipt(id,token,v) {return locked(d=>{
    const existing=d.deliveries.find(n=>n.id===id);const r=sendResult(v,id);
    if(existing?.last_token===token&&digest(existing.receipt)===digest(r))return existing;
    const n=delivery(d,id,token);if(n.state!=='sending' && !(n.state==='claimed'&&r.status==='not_sent'))fail('Receipt needs a durable send intent');
    // Provider IDs must remain unambiguous within this destination.
    if(r.status==='api_accepted' && d.deliveries.some(x=>x.id!==id&&x.task_id===n.task_id&&x.channel===n.channel&&x.receipt?.message_id===r.message_id))fail('Provider receipt ID already belongs to another message');
    n.receipt=r;n.state=r.status;n.last_token=token;n.lease=null;save(d);return n;
  });}
  async function deliver(args) {
    const results=[];const limit=number(args.limit,10,100);
    for(let i=0;i<limit;i++) {
      const n=await next({...args,channel:'feishu'});if(!n)break;
      let adapter,body,format,snapshot;
      try {
        snapshot=await locked(d=>{const b=binding(d,n.task_id);return {...active(store,b),b};});
        ({adapter}=await bounded(()=>loadConnector(snapshot.c),15000));format=n.message.format;
        if(!snapshot.c.capabilities.formats.includes(format))fail('Unsupported message format');
        body=adapter.render(format,responseDocument(n.message.response??{template:'detail',title:({question:'Question',question_update:'Updated question',blocked:'Action needed',completed:'Task result',user_message:'User message'})[n.message.kind]??'Task conversation',lead:n.message.text}));
        if(body===undefined||Buffer.byteLength(JSON.stringify(body))>28000)fail('Rendered message exceeds bounds');
      } catch {results.push(await receipt(n.id,n.lease.token,{status:'not_sent',idempotency_key:n.id,retryable:false,error_code:'adapter-preflight-failed'}));continue;}
      await begin(n.id,n.lease.token);let result;
      try {result=await bounded(signal=>adapter.reply({account_id:snapshot.g.account,destination:{type:'chat_id',id:snapshot.g.destination},format,body,reply_to:n.root_id,reply_in_thread:true,idempotency_key:n.id},{signal}));}catch{result=null;}
      results.push(await receipt(n.id,n.lease.token,result));
    }
    return {deliveries:results};
  }
  async function run(args) {
    const cmd=args.command;
    if(cmd==='conversation-next')return next(args);
    if(cmd==='conversation-begin')return begin(args.id,args.token);
    if(cmd==='conversation-receipt')return receipt(args.id,args.token,sanitizeFile(args.file));
    if(cmd==='conversation-deliver')return deliver(args);
    return locked(d=>{
      if(cmd==='conversation-bind')return bind(d,args.id,sanitizeFile(args.file));
      if(cmd==='conversation-show'){const b=d.bindings.find(b=>b.id===args.id);if(!b)return {bound:false,task:store.get(args.id)};save(d);let authority='active';try{active(store,b);}catch{authority='blocked';}return {...view(d,b),authority};}
      if(cmd==='conversation-disable'){const b=d.bindings.find(b=>b.id===args.id);if(!b)fail('Unknown task conversation');b.enabled=false;save(d);return b;}
      if(cmd==='conversation-publish')return publish(d,args.id,sanitizeFile(args.file));
      if(['conversation-answer','conversation-input'].includes(cmd))return answer(d,args.id,sanitizeFile(args.file),cmd==='conversation-answer');
      if(cmd==='conversation-consume') {
        binding(d,args.id);const v=object(sanitizeFile(args.file),['question_id','expected_revision','expected_answer_id','expected_input_id','authorization_ref','action_ref']);
        for(const k of ['question_id','expected_answer_id','expected_input_id','authorization_ref','action_ref'])identifier(v[k]);
        const q=d.questions.find(q=>q.id===v.question_id&&q.task_id===args.id);
        if(!q||q.revision!==v.expected_revision||q.answer_id!==v.expected_answer_id)fail('Question or input revision conflict');
        const latest=d.answers.filter(a=>a.task_id===args.id).at(-1);
        if(!latest||latest.id!==v.expected_input_id)fail('Newer task input exists; interpret the latest shared conversation first');
        if(latest.redacted||d.answers.find(a=>a.id===q.answer_id)?.redacted)fail('Redacted input is not approval evidence; clarify without secrets');
        const previousAction=d.questions.flatMap(x=>x.consumptions??[]).find(x=>x.action_ref===v.action_ref);
        if(previousAction)return {proceed:false,reconcile:previousAction,question:q};
        if(q.consumed)return {proceed:false,reconcile:q.consumed,question:q};
        if(q.state!=='answered')fail('No unprocessed referenced input; inspect the shared conversation');
        q.consumed={...v,at:stamp()};(q.consumptions??=[]).push(structuredClone(q.consumed));q.state='consumed';save(d);return {proceed:true,question:q,latest_input:latest,referenced_input:d.answers.find(a=>a.id===q.answer_id),permission:'not_granted_by_ledger; active_assistant_must_interpret_latest_context_and_apply_action_specific_policy'};
      }
      if(cmd==='conversation-resolve') {
        const v=object(sanitizeFile(args.file),['status','message_id','evidence']);identifier(v.evidence);
        const n=d.deliveries.find(n=>n.id===args.id);if(!n)fail('Unknown delivery');binding(d,n.task_id);
        if(!['delivery_unknown','not_sent','api_error'].includes(n.state)||n.lease)fail('Only stopped deliveries can be reconciled');
        if(!['api_accepted','not_sent'].includes(v.status))fail('Reconcile accepted or conclusively not sent');
        if(v.status==='api_accepted'){identifier(v.message_id);if(d.deliveries.some(x=>x.id!==n.id&&x.task_id===n.task_id&&x.channel===n.channel&&x.receipt?.message_id===v.message_id))fail('Provider receipt ID conflict');}
        (n.reconciliations??=[]).push({...v,at:stamp()});n.receipt={status:v.status,idempotency_key:n.id,...(v.message_id?{message_id:v.message_id}:{})};n.state=v.status==='not_sent'?'pending':'api_accepted';save(d);return n;
      }
      fail('Unknown conversation command');
    });
  }
  return {run};
}
