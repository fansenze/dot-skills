/** Trusted-dot setup authorization; transport supplies evidence, never authority. */
import crypto from 'node:crypto';
import {digest, requireText, ConnectorError} from './connectors/contract.mjs';
const stamp = () => new Date().toISOString();
const identity = value => { requireText(value, 'identity'); if (/\s/u.test(value)) throw new ConnectorError('Invalid identity'); return value; };
const id = value => { if (!/^[a-z][a-z0-9-]{2,63}$/.test(value ?? '')) throw new ConnectorError('Invalid setup/policy ID'); return value; };
const list = value => [...new Set(requireText(value, 'scope', 2048).split(','))];
const hashText = text => digest(text);
const view = h => { const {challenge_hash, ...rest} = h; return rest; };
export function validateHandshakes(data) {
  data.handshakes ??= [];
  if (!Array.isArray(data.handshakes) || new Set(data.handshakes.map(h => h.id)).size !== data.handshakes.length) throw new ConnectorError('Invalid handshake records');
  for (const h of data.handshakes) {
    if (!h || !/^[a-f0-9]{64}$/.test(h.challenge_hash) || !['pending','consumed','expired','cancelled','conflict'].includes(h.state) ||
      !Number.isFinite(Date.parse(h.issued_at)) || !(Date.parse(h.expires_at) > Date.parse(h.issued_at)) || !h.scope || !h.expected ||
      !data.connections.some(c => c.id === h.connector && c.binding === h.binding) || (h.state === 'consumed' && (!h.evidence || !h.grant_id))) throw new ConnectorError('Invalid handshake evidence');
  }
}
export function expireHandshakes(data) {
  let changed = false;
  for (const h of data.handshakes) if (h.state === 'pending' && Date.now() > Date.parse(h.expires_at)) { h.state = 'expired'; changed = true; }
  return changed;
}
export function handshakeCommand(data, args) {
  const prior = data.handshakes.find(h => h.id === args.id);
  if (args.command !== 'handshake-begin') {
    if (!prior) throw new ConnectorError('Unknown handshake');
    if (prior.state === 'pending' && Date.now() > Date.parse(prior.expires_at)) prior.state = 'expired';
    if (args.command === 'handshake-cancel' && prior.state === 'pending') prior.state = 'cancelled';
    return view(prior);
  }
  // A retry never regenerates a token or changes authority under an existing ID.
  if (prior) throw new ConnectorError('Setup ID already exists; inspect handshake-status; cancel before issuing a new setup ID');
  const c = data.connections.find(c => c.id === args.connector && c.enabled);
  if (!c || !c.capabilities.receive || !c.capabilities.durable_cursor) throw new ConnectorError('Enabled durable connector required');
  const account = identity(args.account), brand = args.brand;
  if (!['feishu','lark'].includes(brand) || (c.settings.account_id && c.settings.account_id !== account) || (c.settings.brand && c.settings.brand !== brand)) throw new ConnectorError('Setup app/brand differs from connector');
  const commands = list(args.commands);
  if (commands.some(v => !['query','create','continue'].includes(v)) || commands.includes('create') !== Boolean(args.allow_new)) throw new ConnectorError('Invalid explicitly authorized agent scope');
  const tasks = args.tasks === 'none' ? [] : args.tasks === 'all' ? ['*'] : list(args.tasks).map(id);
  const scope = {id:id(args.grant_id), connector:c.id, account, destination_type:'chat_id', format:args.format ?? 'card', tasks, enabled:true,
    mode:'agent', commands, allow_new:Boolean(args.allow_new), updates:Boolean(args.updates), reply_mode:args.reply_mode ?? 'reply', language:args.language ?? 'zh'};
  if (!['reply','send'].includes(scope.reply_mode) || !['en','zh'].includes(scope.language) || !c.capabilities[scope.reply_mode] || !c.capabilities.formats.includes(scope.format)) throw new ConnectorError('Unsupported handshake reply format/mode');
  const watch = args.watch_id ? {id:id(args.watch_id), events:['completed']} : null;
  if (args.initial && !watch) throw new ConnectorError('Initial overview requires explicit watch-id');
  if (watch && (!c.capabilities.send || watch.id === scope.id)) throw new ConnectorError('Invalid handshake watch');
  const policies = [...data.grants,...data.watches];
  if (policies.some(p => p.id === scope.id || p.id === watch?.id)) throw new ConnectorError('Reuse existing policies directly; handshake cannot replace or reenable them');
  for (const h of data.handshakes) {
    if (h.state === 'pending' && Date.now() > Date.parse(h.expires_at)) h.state = 'expired';
    if (h.state === 'pending' && h.connector === c.id && h.account === account) throw new ConnectorError('Resolve the existing pending setup first');
  }
  const ttl = Number(args.ttl_ms ?? 600000);
  if (!Number.isSafeInteger(ttl) || ttl < 1000 || ttl > 1800000) throw new ConnectorError('ttl-ms must be 1000..1800000');
  const issued = stamp(), challenge = 'dot-bind:' + crypto.randomBytes(32).toString('hex');
  const h = {id:id(args.id), connector:c.id, binding:c.binding, account, brand, authorization_ref:requireText(args.authorization_ref,'trusted dot authorization reference',2048),
    challenge_hash:hashText(challenge), issued_at:issued, expires_at:new Date(Date.parse(issued)+ttl).toISOString(),
    baseline:{cursor:data.checkpoints.find(p=>p.id===c.id)?.cursor ?? null, recorded_at:issued},
    expected:Object.fromEntries(['tenant','sender','destination'].filter(k=>args[k]!==undefined).map(k=>[k,identity(args[k])])),
    scope, watch, initial:Boolean(args.initial), state:'pending'};
  data.handshakes.push(h);
  return {...view(h), challenge};
}
const tuple = e => ({account:e.account_id,tenant:e.tenant_id,sender:e.sender_id,destination:e.destination_id});
function valid(h,e,now) {
  const received = Date.parse(e.received_at), occurred = Date.parse(e.occurred_at);
  if (h.state !== 'pending' || now > Date.parse(h.expires_at) || e.brand !== h.brand || e.account_id !== h.account || e.provider_app_id !== h.account || e.provider_event_id !== e.event_id ||
    e.chat_type !== 'p2p' || e.sender_type !== 'user' || e.type !== 'text' || e.native_text !== e.text || e.text_omitted ||
    e.parent_id || e.root_id || e.thread_id || !Number.isFinite(received) || !Number.isFinite(occurred) ||
    Math.min(received,occurred) <= Date.parse(h.issued_at) || Math.max(received,occurred) > Math.min(now,Date.parse(h.expires_at)) ||
    e.sender_tenant_id !== e.tenant_id || e.cursor === h.baseline.cursor) return false;
  try { for (const k of ['event_id','message_id','account_id','tenant_id','sender_tenant_id','sender_id','destination_id']) identity(e[k]); } catch { return false; }
  const t = tuple(e);
  return Object.entries(h.expected).every(([k,v])=>t[k]===v);
}
export function matchHandshake(data, connection, e, pageEvents) {
  // Reserve the protocol prefix, including used/expired/malformed challenges. It
  // never enters natural-language intake, even with an existing sender grant.
  if (typeof e.text !== 'string' || !e.text.trim().startsWith('dot-bind:')) return null;
  const h = data.handshakes.find(h=>h.connector===connection.id && h.challenge_hash===hashText(e.text));
  if (!h) return {reason:'handshake-unknown'};
  if (h.state === 'pending' && Date.now() > Date.parse(h.expires_at)) h.state='expired';
  if (!connection.enabled || connection.binding!==h.binding || !valid(h,e,Date.now())) return {reason:'handshake-'+(h.state==='pending'?'invalid-evidence':h.state)};
  const candidates = pageEvents.filter(v=>v.text===e.text && valid(h,v,Date.now()));
  if (new Set(candidates.map(v=>digest(tuple(v)))).size > 1) { h.state='conflict'; return {reason:'handshake-conflicting-identities'}; }
  const grant = {...h.scope, ...tuple(e), since:new Date(Math.max(Date.parse(e.received_at),Date.parse(e.occurred_at))).toISOString()};
  const watch = h.watch ? {id:h.watch.id, connector:connection.id,account:h.account,destination:e.destination_id,destination_type:'chat_id',format:grant.format,
    tasks:grant.tasks, enabled:true, events:h.watch.events,language:grant.language} : null;
  // First binding only. Existing/revoked identities must be reused/reviewed from
  // dot, never implicitly broadened or reactivated by a fresh challenge.
  const conflict = data.grants.some(g=>g.id===grant.id || (g.connector===connection.id && g.account===grant.account && g.tenant===grant.tenant && g.sender===grant.sender && g.destination===grant.destination)) ||
    data.watches.some(w=>w.id===grant.id || w.id===watch?.id || (w.connector===connection.id && w.account===grant.account && w.destination===grant.destination)) || data.grants.some(g=>g.id===watch?.id);
  if (conflict) { h.state='conflict'; return {reason:'handshake-existing-policy-review-required'}; }
  data.grants.push(grant); if(watch)data.watches.push(watch);
  h.state='consumed'; h.consumed_at=stamp(); h.grant_id=grant.id; h.watch_id=watch?.id ?? null;
  h.evidence={...tuple(e),brand:e.brand,provider_app_id:e.provider_app_id,provider_event_id:e.provider_event_id,sender_tenant_id:e.sender_tenant_id,chat_type:e.chat_type,sender_type:e.sender_type,event_id:e.event_id,message_id:e.message_id,
    cursor:e.cursor,occurred_at:e.occurred_at,received_at:e.received_at};
  return {reason:'handshake-consumed',setup_id:h.id,watch,initial:h.initial};
}
