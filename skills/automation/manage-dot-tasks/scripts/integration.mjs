import {readConversations, conversationContext, ownsConversationRoute, conversationCompletionWrites, createConversations} from './task-conversations.mjs';
import {responseDocument, responseFormat, renderConnectorDocument, receiptPresentation, validReceiptPresentation} from './reply-presentation.mjs';
import {validateHandshakes, expireHandshakes, handshakeCommand, matchHandshake} from './identity-handshake.mjs';
import {grantMatches, grantForMessage, configureAllSenders, validateAllSenders, messageTrigger} from './received-intake.mjs';
import {taskResponseDocument as document, taskNotificationDocument} from './presentation.mjs';
/** Transactional notifications and explicitly authorized agent/command intake. */
import {createMessageInbox, agentMessage, grantCovers, messageText, messageEnvelope, validateMessages, validateContextGrants, requestFailureDocument} from './message-inbox.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest, loadConnector, sendResult, bounded, requireText, ConnectorError } from './connectors/contract.mjs';
import {ATTACHMENT_OPTIONS,createAttachments,validateUploads} from './attachments.mjs';

export const INTEGRATION_OPTIONS = {
  ...ATTACHMENT_OPTIONS,
  'handshake-begin': ['id','connector','account','brand','authorization-ref','grant-id','commands','tasks','allow-new','updates','watch-id','initial','tenant','sender','destination','ttl-ms','format','reply-mode','language'],
  'handshake-status': [], 'handshake-cancel': [],
  connect: ['id', 'module', 'settings-file'], connections: [], disconnect: [],
  watch: ['id', 'connector', 'account', 'destination', 'destination-type', 'format', 'events', 'tasks', 'language', 'initial'],
  unwatch: [], 'allow-inbound': ['id', 'connector', 'account', 'tenant', 'sender', 'destination', 'commands', 'tasks', 'since', 'format', 'reply-mode', 'language', 'context-from', 'mode', 'allow-new', 'updates', 'all-senders'],
  'message-next': ['consumer', 'limit', 'lease-ms'], 'message-renew': ['token', 'lease-ms'], 'message-record': ['token', 'decision-file'], 'message-ack': ['token'], 'message-fail': ['token', 'stage', 'reason'],
  'deny-inbound': [], 'request-failure': ['stage', 'reason', 'evidence'], outbox: ['all'], inbound: [],
  ingest: ['connector', 'limit'], deliver: ['consumer', 'limit', 'lease-ms'],
  'retry-notice': ['reason'], 'resolve-notice': ['status', 'message-id', 'reaction-id', 'evidence'],
  start: ['consumer', 'timeout-ms', 'lease-ms', 'limit'],
};
export const INTEGRATION_IDS = ['handshake-status', 'handshake-cancel', 'disconnect', 'unwatch', 'deny-inbound', 'retry-notice', 'resolve-notice', 'message-renew', 'message-record', 'message-ack', 'message-fail', 'request-failure'];
const EVENTS = ['registered', 'progress', 'blocked', 'failed', 'completed', 'verification', 'result', 'execution'];
const FINAL = new Set(['api_accepted', 'api_error', 'delivery_unknown', 'dead', 'cancelled']);
const STATES = ['pending', 'claimed', 'sending', 'recorded', ...FINAL];
const empty = () => ({schema_version: 1, connections: [], watches: [], grants: [], outbox: [], inbox: [], checkpoints: [], handshakes: []});
const encode = value => JSON.stringify(value, null, 2) + '\n';
const stamp = () => new Date().toISOString();
const id = value => { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(value)) throw new ConnectorError('Invalid integration ID'); return value; };
const csv = (value, choices) => {
  const list = [...new Set(requireText(value, 'scope', 2048).split(','))];
  if (choices && list.some(v => !choices.includes(v))) throw new ConnectorError('Unsupported scope value');
  return list;
};
const taskScope = value => value === 'none' ? [] : value === 'all' ? ['*'] : csv(value).map(id);
const covers = (scope, taskId) => scope.includes('*') || scope.includes(taskId);
const count = (value, fallback, max) => { const n = value === undefined ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ConnectorError('Invalid bounded count'); return n; };
const projection = task => {
  const checks = new Map(); for (const c of task.checks) if (c.work_revision === task.work_revision) checks.set(c.name, {name: c.name, outcome: c.outcome, evidence: c.evidence});
  return {title: task.title, goal: task.goal, status: task.status, summary: task.summary ?? '', blocker: task.blocker, next_action: task.next_action,
    steps: task.steps.map(s => ({id: s.id, title: s.title, state: s.state, evidence: s.evidence})), checks: [...checks.values()],
    results: task.results.map(r => ({label: r.label, url: r.url})), completion: task.completion?.summary ?? null,
    execution: {state: task.execution.state, source: task.execution.source, run_id: task.execution.run_id},
    progress: task.events.filter(e => ['progress', 'decision', 'blocker'].includes(e.kind)).at(-1)?.text ?? ''};
};
export function readIntegration(store) {
  const file = store.path('integration.json');
  if (!fs.existsSync(file)) return empty();
  let data; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new ConnectorError('Invalid integration store; preserve it for recovery'); }
  if (data.schema_version !== 1) throw new ConnectorError('Unsupported integration schema');
  for (const list of ['connections', 'watches', 'grants', 'outbox', 'inbox', 'checkpoints']) {
    if (!Array.isArray(data[list])) throw new ConnectorError('Invalid integration records');
    if (data[list].some(row => !row || typeof row.id !== 'string')) throw new ConnectorError('Missing integration identity');
    const ids = data[list].map(row => row.id); if (new Set(ids).size !== ids.length) throw new ConnectorError('Duplicate integration identities');
  }
  for (const c of data.connections) {
    if (typeof c.enabled !== 'boolean' || c.binding !== digest({id: c.id, module: c.module, settings: c.settings, capabilities: c.capabilities, module_sha256: c.module_sha256})) throw new ConnectorError('Connection binding integrity failed');
  }
  validateUploads(data);
  const policies = [...data.watches, ...data.grants];
  if (new Set(policies.map(p => p.id)).size !== policies.length) throw new ConnectorError('Duplicate policy identities');
  for (const p of policies) if (!data.connections.some(c => c.id === p.connector) || !Array.isArray(p.tasks) || typeof p.enabled !== 'boolean') throw new ConnectorError('Invalid policy record');
  for (const n of data.outbox) {
    if (!STATES.includes(n.state) || !data.connections.some(c => c.id === n.route.connector_id) || n.key !== n.id || !Number.isSafeInteger(n.attempts)) throw new ConnectorError('Invalid notification record');
    if (['sending', 'recorded'].includes(n.state) && (n.state === 'sending' ? !n.intent || n.wire_body === undefined : !n.receipt)) throw new ConnectorError('Notification state lacks durable evidence');
    if (['claimed', 'sending'].includes(n.state) && !n.lease) throw new ConnectorError('Notification lease missing');
    const c = data.connections.find(c => c.id === n.route.connector_id), p = policies.find(p => p.id === n.route.policy_id);
    const origin = p?.all_senders ? data.inbox.find(r => r.id === n.route.inbound_id && r.grant_id === p.id && r.connector === c.id) : null;
    if (!p || p.connector !== c.id || (p.all_senders && !origin) || digest(n.route) !== digest(routeFor(c, p, origin)) || n.id !== 'notice-' + digest([n.event_id, n.route]).slice(0, 40)) throw new ConnectorError('Notification route integrity failed');
    if (n.operation !== undefined && n.operation !== 'react') throw new ConnectorError('Invalid notification operation');
    if (n.operation === 'react') {
      const incoming = data.inbox.find(r=>'received:'+r.id===n.event_id && r.grant_id===p.id && r.binding===c.binding);
      if (!validReceiptPresentation(c.capabilities,n,incoming) || n.reply_to || n.reply_in_thread || n.wire_format!==undefined || (n.wire_body!==undefined && digest(n.wire_body)!==digest(n.reaction))) throw new ConnectorError('Invalid receipt reaction');
    } else if (n.reaction !== undefined) throw new ConnectorError('Unexpected receipt reaction');
    if (n.attachment) {
      const upload=data.uploads?.find(u=>u.id===n.attachment.upload_id), origin=data.inbox.find(r=>r.id===n.attachment.inbound_id);
      if (!upload || upload.state!=='uploaded' || upload.binding!==n.route.binding || upload.account!==n.route.account_id || digest(upload.receipt.resource)!==digest(n.attachment.resource) || origin?.grant_id!==p.id || origin?.binding!==c.binding || origin.envelope.destination_id!==n.route.destination.id || n.reply_to!==(origin.envelope.root_id??origin.envelope.message_id) || n.reply_in_thread!==true || (n.wire_body!==undefined && digest(n.wire_body)!==digest({resource_id:upload.key}))) throw new ConnectorError('Attachment route or resource integrity failed');
    }
    if (n.wire_format !== undefined && (!c.capabilities.formats.includes(n.wire_format) || n.wire_format !== (n.attachment?.resource.kind ?? responseFormat(n.document,n.route.format,c.capabilities)))) throw new ConnectorError('Notification wire format integrity failed');
    if (n.reply_in_thread !== undefined && (typeof n.reply_in_thread !== 'boolean' || !n.reply_to)) throw new ConnectorError('Invalid reply options');
    if (n.attempts < 0 || !Number.isFinite(Date.parse(n.available_at)) || (n.lease && !Number.isFinite(Date.parse(n.lease.until)))) throw new ConnectorError('Invalid notification recovery state');
  }
  validateHandshakes(data);
  validateAllSenders(data);
  validateMessages(data);
  return data;
}
export const requestFailures = store => readIntegration(store).inbox.filter(r=>r.failure).map(r=>({id:r.id,...r.failure}));
export function decorateNotifications(store, tasks, language = 'en') {
  const data = readIntegration(store), conversations=readConversations(store), zh = language === 'zh';
  return tasks.map(task => {
    const notices = [...data.outbox,...conversations.deliveries].filter(n => n.task_id === task.id && !['api_accepted', 'cancelled'].includes(n.state));
    if (!notices.length) return task;
    const uncertain = notices.filter(n => n.state === 'delivery_unknown').length;
    const failed = notices.filter(n => ['api_error', 'not_sent', 'dead'].includes(n.state)).length;
    const pending = notices.length - uncertain - failed;
    const parts = [];
    if (uncertain) parts.push(zh ? `通知送达待核查 ${uncertain}` : `Notification delivery unknown: ${uncertain}`);
    if (failed) parts.push(zh ? `通知失败 ${failed}` : `Notification failed: ${failed}`);
    if (pending) parts.push(zh ? `待发送通知 ${pending}` : `Notifications pending: ${pending}`);
    return {...task, notification_summary: parts.join('; ')};
  });
}
const writes = data => ({'integration.json': encode(data)});
function enqueue(data, eventId, route, doc, taskId = null, replyTo = null, replyInThread = false, reaction = null) {
  const noticeId = 'notice-' + digest([eventId, route]).slice(0, 40);
  if (data.outbox.some(n => n.id === noticeId)) return;
  data.outbox.push({id: noticeId, key: noticeId, event_id: eventId, task_id: taskId, route: structuredClone(route),
    document: doc, reply_to: replyTo, ...(reaction ? {operation:'react',reaction} : {}), ...(replyInThread ? {reply_in_thread:true} : {}), state: 'pending', attempts: 0, max_attempts: 3, available_at: stamp(),
    lease: null, intent: null, receipt: null, history: [], created_at: stamp()});
}
const routeFor = (connection, policy, entry = null) => ({connector_id: connection.id, binding: connection.binding, policy_id: policy.id,
  account_id: policy.account, destination: {id: policy.all_senders ? entry.envelope.destination_id : policy.destination, type: policy.destination_type ?? 'chat_id'}, format: policy.format,
  ...(policy.all_senders ? {inbound_id:entry.id} : {})});

// Store.save merges these writes with the task, projections, index and scheduler.
// No connector is loaded, no message is sent, and no source is polled in this hook.
export function taskNotificationWrites(store, task, previous, suppliedData = null) {
  const data = suppliedData ?? readIntegration(store), current = projection(task), prior = previous && projection(previous);
  if (prior && digest(prior) === digest(current)) return {};
  const kinds = [previous ? 'progress' : 'registered'];
  if (['blocked', 'failed', 'completed'].includes(task.status) && previous?.status !== task.status) kinds.push(task.status);
  if (prior ? digest(prior.checks) !== digest(current.checks) : current.checks.length) kinds.push('verification');
  if (prior && digest(prior.results) !== digest(current.results)) kinds.push('result');
  if (prior && digest(prior.execution) !== digest(current.execution)) kinds.push('execution');
  let changed = false;
  const conversationWrites=conversationCompletionWrites(store,task,previous);
  const watchedRoutes = [];
  for (const watch of data.watches) {
    if(ownsConversationRoute(store,task.id,watch))continue;
    const connection = data.connections.find(c => c.id === watch.connector && c.enabled);
    if (!connection || !watch.enabled || !covers(watch.tasks, task.id) || !watch.events.some(k => kinds.includes(k))) continue;
    const associated = data.inbox.filter(r => agentMessage(r) && r.binding === connection.binding && r.task_id === task.id && ['create','continue'].includes(r.decision?.decision)).findLast(r => {
      const g = grantForMessage(data.grants.find(g => g.id === r.grant_id), r);
      return g?.enabled && g.updates && g.reply_mode === 'reply' && g.account === watch.account && g.destination === watch.destination && (watch.destination_type ?? 'chat_id') === 'chat_id' && grantCovers(data,g,task.id);
    });
    const replyTo = connection.capabilities.reply && associated ? associated.envelope.message_id : null;
    enqueue(data, `task:${task.id}:${task.revision}`, routeFor(connection, watch), taskNotificationDocument(task, watch.language), task.id, replyTo, Boolean(replyTo));
    watchedRoutes.push(routeFor(connection, watch));
    changed = true;
  }
  // Progress follows an explicit updates grant and an agent-recorded association.
  // Preserve the latest request per sender/chat without creating identity grants.
  if (previous && task.status === 'completed' && previous.status !== 'completed') for (const policy of data.grants.filter(g => g.mode === 'agent' && g.enabled && g.updates)) {
    const connection = data.connections.find(c => c.id === policy.connector && c.enabled);
    if (!connection) continue;
    const anchors = new Map();
    for (const r of data.inbox.filter(r => agentMessage(r) && r.grant_id === policy.id && r.binding === connection.binding && r.task_id === task.id && ['create','continue'].includes(r.decision?.decision))) {
      anchors.set(policy.all_senders ? digest([r.envelope.tenant_id,r.envelope.sender_id,r.envelope.destination_id]) : policy.id, r);
    }
    for (const anchor of anchors.values()) {
      const grant = grantForMessage(policy, anchor);
      if (ownsConversationRoute(store,task.id,grant) || !grantCovers(data,grant,task.id)) continue;
      const route = routeFor(connection, grant, anchor);
      // A watch is the primary task-update route. Keep decision replies separate.
      if (watchedRoutes.some(w => w.connector_id === route.connector_id && w.binding === route.binding &&
        w.account_id === route.account_id && w.destination.id === route.destination.id &&
        w.destination.type === route.destination.type && w.format === route.format)) continue;
      enqueue(data, 'task:'+task.id+':'+task.revision, route, taskNotificationDocument(task, grant.language ?? 'zh'), task.id, grant.reply_mode === 'reply' ? anchor.envelope.message_id : null, grant.reply_mode === 'reply');
      changed = true;
    }
  }
  return {...conversationWrites,...(changed ? writes(data) : {})};
}

export function createIntegration({store, scheduler, makeTask}) {
  const locked = fn => store.locked(() => { store.config(); return fn(); });
  const save = data => store.commit(writes(data));
  const attachments=createAttachments({locked,read:()=>readIntegration(store),save});
  const messages = createMessageInbox({store,scheduler,makeTask,read:readIntegration,save,writes,routeFor,enqueue,document,taskNotices:taskNotificationWrites});
  const publicNotice = n => ({id: n.id, event_id: n.event_id, task_id: n.task_id, route: n.route, state: n.state,
    ...(n.attachment ? {attachment:n.attachment} : {}),
    ...(n.operation ? {operation:n.operation,reaction:n.reaction} : {}), attempts: n.attempts, available_at: n.available_at, receipt: n.receipt});
  function policyActive(data, notice) {
    const c = data.connections.find(c => c.id === notice.route.connector_id);
    const policy = [...data.watches, ...data.grants].find(p => p.id === notice.route.policy_id && p.connector === c?.id);
    const p = grantForMessage(policy, data.inbox.find(r => r.id === notice.route.inbound_id));
    return c?.enabled && c.binding === notice.route.binding && p?.enabled && (!notice.task_id || grantCovers(data,p,notice.task_id));
  }
  function getLease(data, noticeId, token) {
    const n = data.outbox.find(n => n.id === noticeId);
    if (!n || !n.lease || n.lease.token !== token || Date.parse(n.lease.until) <= Date.now()) throw new ConnectorError('Notification lease expired or replaced');
    return n;
  }
  function finish(n) {
    n.history.push({at: stamp(), receipt: n.receipt});
    if (n.receipt.status === 'not_sent') {
      n.state = n.receipt.retryable && n.attempts < n.max_attempts ? 'pending' : 'dead';
      n.available_at = new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(6, n.attempts))).toISOString();
    } else n.state = n.receipt.status;
    n.lease = null;
  }
  async function claim(consumer, leaseMs = 120000) {
    return locked(() => {
      const data = readIntegration(store); let changed = false;
      for (const n of data.outbox) {
        if (!n.lease || Date.parse(n.lease.until) > Date.now()) continue;
        if (n.state === 'sending') { n.receipt = sendResult(null, n.key, n.operation); n.receipt.error_code = 'sender-interrupted'; finish(n); }
        else if (n.state === 'recorded') finish(n);
        else if (n.state === 'claimed') { n.state = n.attempts >= n.max_attempts ? 'dead' : 'pending'; n.lease = null; }
        changed = true;
      }
      let selected;
      // Receipt acknowledgements precede task snapshots in each bounded delivery batch.
      for (const n of [...data.outbox].sort((a,b)=>Number(!a.event_id.startsWith('received:'))-Number(!b.event_id.startsWith('received:')))) {
        if (n.state !== 'pending' || Date.parse(n.available_at) > Date.now()) continue;
        if (!policyActive(data, n)) { n.state = 'cancelled'; changed = true; continue; }
        n.state = 'claimed'; n.attempts++; n.lease = {consumer, token: crypto.randomUUID(), until: new Date(Date.now() + leaseMs).toISOString()};
        selected = structuredClone(n); changed = true; break;
      }
      if (changed) save(data); return selected ?? null;
    });
  }
  async function begin(noticeId, token, body, format) {
    return locked(() => {
      const data = readIntegration(store), n = getLease(data, noticeId, token);
      if (n.state !== 'claimed' || !policyActive(data, n)) throw new ConnectorError('Notification is not authorized for a new send');
      if (n.wire_body !== undefined && digest(n.wire_body) !== digest(body)) throw new ConnectorError('Retry payload must remain identical');
      if (n.wire_format !== undefined && n.wire_format !== format) throw new ConnectorError('Retry format must remain identical');
      n.wire_format = format;
      n.wire_body = structuredClone(body); n.intent = {at: stamp(), attempt: n.attempts}; n.state = 'sending'; n.receipt = null;
      save(data); return structuredClone(n);
    });
  }
  async function record(noticeId, token, raw) {
    return locked(() => {
      const data = readIntegration(store), n = getLease(data, noticeId, token), result = sendResult(raw, n.key, n.operation);
      if (n.state === 'recorded' && digest(n.receipt) === digest(result)) return n.receipt;
      if (!['sending', 'claimed'].includes(n.state) || (n.state === 'claimed' && result.status !== 'not_sent')) throw new ConnectorError('Invalid notification receipt transition');
      n.receipt = result; n.state = 'recorded'; save(data); return result;
    });
  }
  async function ack(noticeId, token) {
    return locked(() => {
      const data = readIntegration(store), existing = data.outbox.find(n => n.id === noticeId);
      if (existing?.acked_token === token) return publicNotice(existing);
      const n = getLease(data, noticeId, token);
      if (n.state !== 'recorded') throw new ConnectorError('Persist a notification receipt before acknowledgement');
      n.acked_token = token; finish(n); save(data); return publicNotice(n);
    });
  }
  async function deliver(args) {
    const consumer = id(args.consumer), limit = count(args.limit, 10, 100), leaseMs = count(args.lease_ms, 120000, 3600000), sent = [];
    for (let i = 0; i < limit; i++) {
      const n = await claim(consumer, leaseMs); if (!n) break;
      let adapter, body, format;
      try {
        const c = await locked(() => readIntegration(store).connections.find(c => c.id === n.route.connector_id));
        ({adapter} = await bounded(() => loadConnector(c), 15000));
        format = n.operation === 'react' ? undefined : n.wire_format ?? n.attachment?.resource.kind ?? responseFormat(n.document, n.route.format, c.capabilities);
        body = n.wire_body ?? (n.attachment ? {resource_id:n.attachment.resource.upload_id} : n.operation === 'react' ? n.reaction : renderConnectorDocument(c.capabilities,format,structuredClone(n.document)));
        if(n.attachment && (!c.capabilities.upload || !c.capabilities.formats.includes(format))) throw new ConnectorError('Attachment capability unavailable');
        if (body === undefined || Buffer.byteLength(JSON.stringify(body)) > 28000) throw new ConnectorError('Notification render exceeds bounds');
      } catch {
        await record(n.id, n.lease.token, {status: 'not_sent', idempotency_key: n.key, retryable: false, error_code: 'adapter-preflight-failed'});
        sent.push(await ack(n.id, n.lease.token)); continue;
      }
      const intent = await begin(n.id, n.lease.token, body, format);
      let result;
      try {
        result = await bounded(signal => intent.operation === 'react' ? adapter.react({account_id:intent.route.account_id,...intent.wire_body,idempotency_key:intent.key},{signal}) : adapter[intent.reply_to ? 'reply' : 'send']({account_id: intent.route.account_id,
          destination: intent.route.destination, format: intent.wire_format ?? intent.route.format, body: intent.wire_body,
          reply_to: intent.reply_to, ...(intent.reply_in_thread !== undefined ? {reply_in_thread:intent.reply_in_thread} : {}), idempotency_key: intent.key}, {signal}));
      } catch { result = null; }
      await record(n.id, n.lease.token, result); sent.push(await ack(n.id, n.lease.token));
    }
    return {notifications: sent};
  }
  function parseCommand(event) {
    if (event.type !== 'text' || typeof event.text !== 'string' || event.text.length > 512) return null;
    const text = event.text.trim();
    if (/[\x00-\x1f\x7f]/.test(text)) return null;
    const match = /^\/tasks (list|show|run|verify)(?: ([a-z][a-z0-9-]{2,63}))?(?: ([^\r\n]{1,128}))?$/.exec(text);
    if (!match) return null;
    const [, verb, taskId, check] = match;
    if ((verb === 'list' && (taskId || check)) || (verb !== 'list' && !taskId) || (verb === 'verify' ? !check : check)) return null;
    return {verb, task_id: taskId ?? null, check_name: check ?? null};
  }
  async function ingest(args) {
    const snapshot = await locked(() => {
      const data = readIntegration(store), c = data.connections.find(c => c.id === args.connector && c.enabled);
      if (!c) throw new ConnectorError('Unknown or disabled connector');
      if (expireHandshakes(data)) save(data);
      if (!data.grants.some(g => g.connector === c.id && g.enabled) && !data.handshakes.some(h => h.connector === c.id && h.state === 'pending')) return null;
      if (!c.capabilities.receive || !c.capabilities.durable_cursor) throw new ConnectorError('Connector lacks durable receive capability');
      return {c, cursor: data.checkpoints.find(p => p.id === c.id)?.cursor ?? null};
    });
    if (!snapshot) return {ingested: 0};
    const {adapter} = await bounded(() => loadConnector(snapshot.c), 15000);
    const page = await bounded(signal => adapter.receive({cursor: snapshot.cursor, limit: count(args.limit, 100, 1000), signal}), 15000);
    if (!page || !Array.isArray(page.events) || page.events.length > 1000 || typeof page.next_cursor !== 'string' || typeof page.has_more !== 'boolean') throw new ConnectorError('Invalid receive page; checkpoint unchanged');
    // Validate the complete envelope before committing any checkpoint. Text and
    // sender fields are untrusted optional data; authorization rejects them.
    let validatedCursor = snapshot.cursor;
    const cursors = new Set();
    for (const e of page.events) {
      requireText(e.cursor, 'event cursor', 4096);
      for (const key of ['event_id', 'message_id', 'account_id', 'tenant_id', 'destination_id']) requireText(e[key], 'event identity');
      if (e.cursor === validatedCursor || cursors.has(e.cursor)) throw new ConnectorError('Receive cursor did not advance');
      cursors.add(e.cursor); validatedCursor = e.cursor;
    }
    requireText(page.next_cursor, 'page cursor', 4096);
    if ((page.events.length && validatedCursor !== page.next_cursor) || (!page.events.length && snapshot.cursor !== null && snapshot.cursor !== page.next_cursor)) throw new ConnectorError('Receive final cursor mismatch');
    let cursor = snapshot.cursor, ingested = 0;
    for (const e of page.events) {
      await locked(() => {
        const data = readIntegration(store), cp = data.checkpoints.find(p => p.id === snapshot.c.id);
        if ((cp?.cursor ?? null) !== cursor) throw new ConnectorError('Inbox checkpoint advanced concurrently; reread');
        const messageKey = digest([snapshot.c.id, e.account_id, e.tenant_id, e.message_id]), eventKey = digest([snapshot.c.id, e.account_id, e.tenant_id, e.event_id]);
        const seen = data.inbox.some(r => r.id === messageKey || r.event_key === eventKey);
        const command = parseCommand(e);
        const candidates = data.grants.filter(g => g.connector === snapshot.c.id);
        const allSenders = candidates.find(g => g.all_senders && g.enabled && g.account === e.account_id) ?? candidates.findLast(g => g.all_senders && g.account === e.account_id);
        const grant = (allSenders ? [allSenders] : candidates).find(g => grantMatches(g, e) &&
          ((g.mode === 'agent') || (g.mode !== 'agent' && command && g.commands.includes(command.verb) && (!command.task_id || covers(g.tasks, command.task_id)))));
        if (cp) cp.cursor = e.cursor; else data.checkpoints.push({id: snapshot.c.id, cursor: e.cursor});
        if (seen) { save(data); return; }
        const entry = {id: messageKey, event_key: eventKey, connector: snapshot.c.id, status: 'rejected', reason: 'not-authorized-or-not-a-command'};
        data.inbox.push(entry);
        const currentConnection = data.connections.find(c => c.id === snapshot.c.id);
        const handshake = allSenders ? null : matchHandshake(data, currentConnection, e, page.events);
        if (handshake) {
          Object.assign(entry, {reason:handshake.reason, ...(handshake.setup_id ? {setup_id:handshake.setup_id,status:'accepted'} : {})});
          if (handshake.watch && handshake.initial) enqueue(data, 'initial:' + handshake.watch.id, routeFor(currentConnection,handshake.watch), document(store.selected({},t=>covers(handshake.watch.tasks,t.id)),handshake.watch.language,false));
          save(data); return;
        }
        if (!currentConnection.enabled || currentConnection.binding !== snapshot.c.binding) { save(data); return; }
        if (!grant) { save(data); return; }
        if (grant.mode === 'agent') {
          if(!messageText(e)){
            const reason = !['text','post'].includes(e.type) ? '不支持此消息类型，请发送文本或含文字的富文本。' : '无法提取安全且完整的正文，请检查格式或发送不超过 8000 字符的文本。';
            Object.assign(entry,{mode:'request_failure',grant_id:grant.id,binding:currentConnection.binding,envelope:messageEnvelope({...e,text:undefined,text_source:undefined,text_omitted:undefined}),status:'failed',reason:'content-unavailable',failure:{stage:'parse',reason,at:stamp()}});
            enqueue(data,'failure:'+messageKey,routeFor(currentConnection,grant,entry),requestFailureDocument(entry,grant.language),null,grant.reply_mode==='reply'?e.message_id:null,grant.reply_mode==='reply');
            save(data);return;
          }
          Object.assign(entry, {mode:'agent', grant_id:grant.id, binding:currentConnection.binding, envelope:messageEnvelope(e), status:'pending', reason:'awaiting-agent', lease:null, decision:null});
          const zh = (grant.language ?? 'zh') === 'zh';
          const receipt = receiptPresentation(currentConnection.capabilities,{entry,history:data.inbox,notices:data.outbox,conversation:conversationContext(store,entry)});
          if (receipt) enqueue(data,'received:'+messageKey,routeFor(currentConnection,grant,entry),responseDocument({template:'ack',lead:zh?'收到，正在处理。':'Received; I am reviewing your request.'},stamp()),null,
            receipt.operation==='react' ? null : grant.reply_mode==='reply' ? e.message_id : null,receipt.operation!=='react' && grant.reply_mode==='reply',receipt.reaction ?? null);
          save(data); return;
        }
        if (command.task_id && !store.index().some(t => t.id === command.task_id)) { entry.reason = 'unknown-task'; save(data); return; }
        if (['list', 'show'].includes(command.verb)) {
          const tasks = command.task_id ? [store.get(command.task_id)] : store.selected({},t=>covers(grant.tasks,t.id));
          enqueue(data, 'inbound:' + messageKey, routeFor(currentConnection, grant), document(tasks, grant.language ?? 'zh', command.verb === 'show'), command.task_id, grant.reply_mode === 'reply' ? e.message_id : null, grant.reply_mode === 'reply');
          entry.status = 'accepted'; entry.reason = 'ledger-response'; save(data); return;
        }
        const task = store.get(command.task_id);
        if ((command.verb === 'run' && !['queued', 'executing'].includes(task.status)) || (command.verb === 'verify' && task.status !== 'awaiting_verification')) {
          entry.reason = 'task-not-ready'; save(data); return;
        }
        entry.status = 'accepted'; entry.reason = 'scheduled'; entry.request_id = 'request-' + messageKey.slice(0, 40);
        // The queue event and source checkpoint share one journal commit.
        scheduler.execute({command: 'schedule', id: task.id, event_id: 'inbound-' + messageKey.slice(0, 40), request_id: entry.request_id,
          source: 'connector-' + snapshot.c.id, source_ref: messageKey, action: command.verb === 'run' ? 'execute' : 'verify',
          authorization_ref: 'grant:' + grant.id, work_revision: task.work_revision, ...(command.check_name ? {check_name: command.check_name} : {})}, writes(data));
      });
      cursor = e.cursor; ingested++;
    }
    if (page.events.length && cursor !== page.next_cursor) throw new ConnectorError('Receive final cursor mismatch');
    if (!page.events.length && cursor !== page.next_cursor) {
      await locked(() => {
        const data = readIntegration(store), cp = data.checkpoints.find(p => p.id === snapshot.c.id);
        if ((cp?.cursor ?? null) !== cursor) throw new ConnectorError('Inbox checkpoint advanced concurrently');
        // A fresh empty stream may supply its initial cursor, never skip an existing stream.
        if (cursor !== null) throw new ConnectorError('Empty receive page advanced an existing checkpoint');
        data.checkpoints.push({id: snapshot.c.id, cursor: page.next_cursor}); save(data);
      });
    }
    return {ingested, has_more: page.has_more};
  }
  async function run(args) {
    if (Object.hasOwn(ATTACHMENT_OPTIONS,args.command) && args.command!=='attachment-reply') return attachments.run(args);
    if (args.command==='attachment-reply') return locked(()=>{
      const data=readIntegration(store), upload=data.uploads?.find(u=>u.id===args.resource_id), entry=data.inbox.find(r=>r.id===args.inbound_id);
      requireText(args.id,'attachment message ID');requireText(args.authorization_ref,'attachment disclosure authorization');
      if (!upload || upload.state!=='uploaded' || !entry || !agentMessage(entry) || !['claimed','recorded','done'].includes(entry.status)) throw new ConnectorError('Attachment reply requires an uploaded resource and reviewed intake');
      const c=data.connections.find(c=>c.id===entry.connector&&c.enabled), g=grantForMessage(data.grants.find(g=>g.id===entry.grant_id),entry);
      if(!c || !g?.enabled || !c.capabilities.upload || !c.capabilities.reply || upload.binding!==c.binding || upload.account!==entry.envelope.account_id || (entry.task_id&&!grantCovers(data,g,entry.task_id))) throw new ConnectorError('Attachment source or account is outside the active binding');
      const eventId='attachment:'+args.id, route=routeFor(c,g,entry), attachment={upload_id:upload.id,inbound_id:entry.id,resource:structuredClone(upload.receipt.resource),authorization_ref:args.authorization_ref};
      const prior=data.outbox.find(n=>n.event_id===eventId);
      if(prior){if(digest(prior.attachment)!==digest(attachment)||digest(prior.route)!==digest(route))throw new ConnectorError('Attachment message ID conflicts with prior route or resource');return publicNotice(prior);}
      enqueue(data,eventId,route,null,entry.task_id??null,entry.envelope.root_id??entry.envelope.message_id,true);
      const notice=data.outbox.at(-1);notice.attachment=attachment;save(data);return publicNotice(notice);
    });
    if (args.command.startsWith('message-')) return messages.run(args);
    if (args.command === 'start') {
      const timeout = args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new ConnectorError('timeout-ms must be 0..60000');
      const deadline = performance.now() + timeout, consumer = args.consumer ?? 'dot-active';
      const issueStates = new Set(['delivery_unknown', 'not_sent', 'api_error']);
      // Retain old issues for inspection without interrupting every idle call.
      // Snapshot before delivery recovery so a newly expired send still wakes dot.
      const initialIssues = await locked(() => new Map(readConversations(store).deliveries
        .filter(n => issueStates.has(n.state)).map(n => [n.id, n.state])));
      let ingested = 0; const notifications = [], gaps = [];
      do {
        const connections = await locked(() => readIntegration(store).connections.filter(c => c.enabled));
        for (const c of connections) {
          try { ingested += (await ingest({connector: c.id, limit: 100})).ingested; }
          catch { if (!gaps.includes(c.id)) gaps.push(c.id); }
        }
        notifications.push(...(await deliver({consumer, limit: args.limit ?? 10, lease_ms: args.lease_ms})).notifications);
        const conversations=createConversations({store});
        notifications.push(...(await conversations.run({command:'conversation-deliver',consumer,limit:args.limit??10,lease_ms:args.lease_ms})).deliveries);
        const dotDelivery=await conversations.run({command:'conversation-next',channel:'dot',consumer,lease_ms:args.lease_ms});
        const {conversationIssues, issuesChanged} = await locked(() => {
          const rows = readConversations(store).deliveries.filter(n => issueStates.has(n.state));
          return {
            conversationIssues: {total: rows.length, deliveries: rows.slice(0, 20).map(n => ({id:n.id, task_id:n.task_id, channel:n.channel, state:n.state}))},
            issuesChanged: rows.some(n => initialIssues.get(n.id) !== n.state),
          };
        });
        const claimed = await messages.claim({consumer,limit:args.limit ?? 1,lease_ms:args.lease_ms,require_receipt_attempt:true});
        const queued = await scheduler.wait({command: 'wait', consumer, timeout_ms: issuesChanged || claimed.messages.length || dotDelivery ? 0 : Math.max(0, Math.min(5000, Math.round(deadline - performance.now()))), limit: args.limit ?? 1, lease_ms: args.lease_ms});
        if (issuesChanged || dotDelivery || claimed.messages.length || queued.batch.length || ingested || notifications.length || gaps.length || performance.now() >= deadline) {
          return {...queued, conversation_issues:conversationIssues, conversation_deliveries:{dot:dotDelivery?[dotDelivery]:[]}, messages:claimed.messages, ingested, notifications, receive_gaps: gaps, readiness: connections.length ? 'configured-bindings; live transport not attested' : 'local-only; no server binding'};
        }
      } while (true);
    }
    if (args.command === 'deliver') return deliver(args);
    if (args.command === 'ingest') return ingest(args);
    if (args.command === 'connect') {
      let settings;
      try {
        if (fs.statSync(args.settings_file).size > 65536) throw new Error();
        settings = JSON.parse(fs.readFileSync(args.settings_file, 'utf8'));
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error();
      } catch { throw new ConnectorError('Settings must be a readable JSON object within 64 KiB; private content suppressed'); }
      const spec = {id: id(args.id), module: path.resolve(requireText(args.module, 'module', 2048)), settings};
      const loaded = await bounded(() => loadConnector(spec), 15000);
      return locked(() => {
        const data = readIntegration(store), c = {...spec, capabilities: loaded.capabilities, module_sha256: loaded.module_sha256};
        c.binding = digest(c); c.enabled = true;
        const prior = data.connections.find(v => v.id === c.id);
        if (prior && prior.binding !== c.binding) throw new ConnectorError('Connection identity is immutable; choose a new ID to rebind');
        if (prior) prior.enabled = true; else data.connections.push(c);
        save(data); return c;
      });
    }
    return locked(() => {
      const data = readIntegration(store), cmd = args.command;
      if (cmd.startsWith('handshake-')) { const result = handshakeCommand(data,args); save(data); return result; }
      if (cmd === 'connections') return data.connections;
      if(cmd==='request-failure'){
        const r=data.inbox.find(r=>r.id===args.id);
        if(!r || r.mode || r.status!=='rejected' || r.task_id)throw new ConnectorError('Only a historical rejected request without a task may be annotated');
        if(!['parse','create'].includes(args.stage))throw new ConnectorError('Failure stage must be parse or create');
        requireText(args.reason,'failure reason',1000);requireText(args.evidence,'review evidence',1000);
        if(scheduler.execute({command:'lookup',source:'connector-'+r.connector,source_ref:r.id}))throw new ConnectorError('Reconcile the existing task binding first');
        const prior=r.failure;if(prior&&(prior.stage!==args.stage||prior.reason!==args.reason||prior.evidence!==args.evidence))throw new ConnectorError('Recorded failure is immutable');
        r.failure=prior??{stage:args.stage,reason:args.reason,evidence:args.evidence,at:stamp()};save(data);
        return {id:r.id,status:'failed',task_id:null,duplicate:Boolean(prior),notification:'none; historical annotation never replays or sends'};
      }
      if (cmd === 'outbox') return data.outbox.filter(n => args.all || !['api_accepted', 'cancelled'].includes(n.state)).map(publicNotice);
      if (cmd === 'inbound') return {checkpoints: data.checkpoints, outcomes: data.inbox.map(r => agentMessage(r) ? {id:r.id,event_key:r.event_key,connector:r.connector,grant_id:r.grant_id,mode:r.mode,status:r.failure?'failed':r.status,reason:r.reason,task_id:r.task_id??null,trigger:messageTrigger(r.envelope),summary:r.decision?.summary??null,...(r.failure?{failure:r.failure}:{})} : r.failure ? {id:r.id,connector:r.connector,grant_id:r.grant_id,status:'failed',task_id:null,...(r.envelope?{trigger:messageTrigger(r.envelope)}:{}),failure:r.failure} : r)};
      if (['disconnect', 'unwatch', 'deny-inbound'].includes(cmd)) {
        const list = cmd === 'disconnect' ? data.connections : cmd === 'unwatch' ? data.watches : data.grants;
        const item = list.find(v => v.id === args.id); if (!item) throw new ConnectorError('Unknown binding');
        item.enabled = false;
        save(data); return {id: item.id, enabled: false};
      }
      if (cmd === 'watch' || cmd === 'allow-inbound') {
        const c = data.connections.find(c => c.id === args.connector && c.enabled); if (!c) throw new ConnectorError('Unknown or disabled connector');
        const allSenders = cmd === 'allow-inbound' && args.all_senders;
        const p = {id: id(args.id), connector: c.id, account: requireText(args.account, 'account'), ...(!allSenders ? {destination: requireText(args.destination, 'destination')} : {}),
          destination_type: args.destination_type ?? 'chat_id', format: args.format ?? (c.capabilities.presentation === 'feishu' ? 'card' : 'markdown'), tasks: taskScope(args.tasks), enabled: true};
        if (!['text', 'markdown', 'card'].includes(p.format)) throw new ConnectorError('Unsupported notification format');
        const requireOutbound = method => {
          if (!c.capabilities[method] || !c.capabilities.formats.includes(p.format)) throw new ConnectorError(`Requested format/${method} capability unavailable; choose an explicit supported format`);
        };
        let list;
        if (cmd === 'watch') {
          requireOutbound('send');
          p.events = csv(args.events ?? 'completed', EVENTS); p.language = args.language ?? 'zh'; if (!['en', 'zh'].includes(p.language)) throw new ConnectorError('Invalid language'); list = data.watches;
        } else {
          if (!c.capabilities.receive || !c.capabilities.durable_cursor) throw new ConnectorError('Durable inbox capability required');
          if (allSenders) configureAllSenders(data, c, p, args);
          else {
            p.tenant = requireText(args.tenant, 'tenant'); p.sender = requireText(args.sender, 'sender');
          }
          if (!['commands','agent'].includes(args.mode ?? 'commands')) throw new ConnectorError('Invalid inbound mode');
          if (args.mode === 'agent') {
            if (args.language !== undefined) { if (!['en','zh'].includes(args.language)) throw new ConnectorError('Invalid language'); p.language = args.language; }
            p.mode = 'agent'; p.allow_new = Boolean(args.allow_new); p.updates = Boolean(args.updates);
            p.commands = csv(args.commands, ['query','create','continue']);
            if (args.context_from !== undefined) { p.context_from=csv(args.context_from).map(id); validateContextGrants(data,p); }
            if (p.commands.includes('create') !== p.allow_new) throw new ConnectorError('Create scope and allow-new must be explicitly enabled together');
          } else {
            if (args.allow_new || args.updates || args.context_from !== undefined) throw new ConnectorError('Agent options require agent mode');
            p.commands = csv(args.commands, ['list','show','run','verify']);
          }
          p.reply_mode = args.reply_mode ?? 'reply';
          if (!['reply', 'send'].includes(p.reply_mode)) throw new ConnectorError('Invalid reply mode');
          // Only list/show produce responses. Dispatch-only grants need no
          // outbound method or output format capability, including verify.
          if (p.mode === 'agent' || p.commands.some(command => ['list', 'show'].includes(command))) requireOutbound(p.reply_mode);
          p.since = args.since ?? data.grants.find(g => g.id === p.id)?.since ?? stamp(); if (!Number.isFinite(Date.parse(p.since))) throw new ConnectorError('Invalid authorization start time'); list = data.grants;
        }
        const prior = list.find(v => v.id === p.id);
        if (prior && digest({...prior, enabled: true}) !== digest(p)) throw new ConnectorError('Policy identity is immutable; disable it and use a new ID to change scope');
        if (!prior && [...data.watches, ...data.grants].some(v => v.id === p.id)) throw new ConnectorError('Policy ID already exists');
        if (prior) prior.enabled = true; else list.push(p);
        if (allSenders) for (const setup of data.handshakes.filter(h => h.connector === c.id && h.account === p.account && h.state === 'pending')) setup.state = 'cancelled';
        if (cmd === 'watch' && args.initial && !prior) enqueue(data, 'initial:' + p.id, routeFor(c, p), document(store.selected({},t=>covers(p.tasks,t.id)), p.language, false));
        save(data); return p;
      }
      const n = data.outbox.find(n => n.id === args.id); if (!n) throw new ConnectorError('Unknown notification');
      if (n.lease) throw new ConnectorError('Resolve the outstanding send lease first');
      if (cmd === 'retry-notice') {
        requireText(args.reason, 'retry reason', 1000);
        if (!['dead', 'api_error'].includes(n.state)) throw new ConnectorError('Unknown delivery cannot be retried; reconcile it first');
        if (!policyActive(data, n)) throw new ConnectorError('Original notification policy is disabled');
        n.history.push({at: stamp(), retry_reason: args.reason}); n.state = 'pending'; n.max_attempts = n.attempts + 3; n.available_at = stamp();
      } else if (cmd === 'resolve-notice') {
        if (n.state !== 'delivery_unknown') throw new ConnectorError('Only unknown delivery requires reconciliation');
        requireText(args.evidence, 'reconciliation evidence', 1000);
        if (!['api_accepted', 'not_sent'].includes(args.status)) throw new ConnectorError('Resolution must establish API acceptance or no send');
        const resultId = n.operation === 'react' ? 'reaction_id' : 'message_id';
        if (args.status === 'api_accepted') requireText(args[resultId], 'actual '+resultId);
        n.receipt = {status: args.status, idempotency_key: n.key, retryable: false, ...(args[resultId] ? {[resultId]:args[resultId]} : {})};
        n.history.push({at: stamp(), resolution: args.evidence}); finish(n);
      } else throw new ConnectorError('Unknown integration command');
      save(data); return publicNotice(n);
    });
  }
  return {run, claim, begin, record, ack, deliver, ingest};
}
