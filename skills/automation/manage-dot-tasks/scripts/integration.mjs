/** Transactional notifications and explicitly authorized inbound task commands. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest, loadConnector, sendResult, bounded, requireText, ConnectorError } from './connectors/contract.mjs';

export const INTEGRATION_OPTIONS = {
  connect: ['id', 'module', 'settings-file'], connections: [], disconnect: [],
  watch: ['id', 'connector', 'account', 'destination', 'destination-type', 'format', 'events', 'tasks', 'language', 'initial'],
  unwatch: [], 'allow-inbound': ['id', 'connector', 'account', 'tenant', 'sender', 'destination', 'commands', 'tasks', 'since', 'format', 'reply-mode'],
  'deny-inbound': [], outbox: ['all'], inbound: [],
  ingest: ['connector', 'limit'], deliver: ['consumer', 'limit', 'lease-ms'],
  'retry-notice': ['reason'], 'resolve-notice': ['status', 'message-id', 'evidence'],
  start: ['consumer', 'timeout-ms', 'lease-ms', 'limit'],
};
export const INTEGRATION_IDS = ['disconnect', 'unwatch', 'deny-inbound', 'retry-notice', 'resolve-notice'];
const EVENTS = ['registered', 'progress', 'blocked', 'failed', 'completed', 'verification', 'result', 'execution'];
const FINAL = new Set(['api_accepted', 'api_error', 'delivery_unknown', 'dead', 'cancelled']);
const STATES = ['pending', 'claimed', 'sending', 'recorded', ...FINAL];
const empty = () => ({schema_version: 1, connections: [], watches: [], grants: [], outbox: [], inbox: [], checkpoints: []});
const encode = value => JSON.stringify(value, null, 2) + '\n';
const stamp = () => new Date().toISOString();
const id = value => { if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(value)) throw new ConnectorError('Invalid integration ID'); return value; };
const csv = (value, choices) => {
  const list = [...new Set(requireText(value, 'scope', 2048).split(','))];
  if (choices && list.some(v => !choices.includes(v))) throw new ConnectorError('Unsupported scope value');
  return list;
};
const taskScope = value => value === 'all' ? ['*'] : csv(value).map(id);
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
function document(tasks, language = 'en') {
  const zh = language === 'zh';
  return {title: zh ? '任务列表' : 'Tasks', updated_at: stamp(), columns: zh ? ['标题', '状态', '信息描述'] : ['Title', 'Status', 'Summary'],
    rows: tasks.map(t => {
      const p = projection(t), failures = p.checks.filter(c => c.outcome === 'fail').map(c => c.name);
      return [t.title, t.status === 'completed' ? '✅ ' + t.completion.at : ['queued', 'cancelled'].includes(t.status) ? '🕒 ' + t.status : '🚧 ' + t.status,
        [t.completion?.summary ?? (t.summary || p.progress || t.next_action), t.blocker, ...failures].filter(Boolean).join('; ')];
    }), details: tasks.length === 1 ? [tasks[0].goal, tasks[0].blocker, ...projection(tasks[0]).checks.map(c => `${c.outcome}: ${c.name} · ${c.evidence}`),
      ...tasks[0].results.map(r => `${r.label}: ${r.url}`)].filter(Boolean) : []};
}
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
  const policies = [...data.watches, ...data.grants];
  if (new Set(policies.map(p => p.id)).size !== policies.length) throw new ConnectorError('Duplicate policy identities');
  for (const p of policies) if (!data.connections.some(c => c.id === p.connector) || !Array.isArray(p.tasks) || typeof p.enabled !== 'boolean') throw new ConnectorError('Invalid policy record');
  for (const n of data.outbox) {
    if (!STATES.includes(n.state) || !data.connections.some(c => c.id === n.route.connector_id) || n.key !== n.id || !Number.isSafeInteger(n.attempts)) throw new ConnectorError('Invalid notification record');
    if (['sending', 'recorded'].includes(n.state) && (n.state === 'sending' ? !n.intent || n.wire_body === undefined : !n.receipt)) throw new ConnectorError('Notification state lacks durable evidence');
    if (['claimed', 'sending'].includes(n.state) && !n.lease) throw new ConnectorError('Notification lease missing');
    const c = data.connections.find(c => c.id === n.route.connector_id), p = policies.find(p => p.id === n.route.policy_id);
    if (!p || p.connector !== c.id || digest(n.route) !== digest(routeFor(c, p)) || n.id !== 'notice-' + digest([n.event_id, n.route]).slice(0, 40)) throw new ConnectorError('Notification route integrity failed');
    if (n.attempts < 0 || !Number.isFinite(Date.parse(n.available_at)) || (n.lease && !Number.isFinite(Date.parse(n.lease.until)))) throw new ConnectorError('Invalid notification recovery state');
  }
  return data;
}
export function decorateNotifications(store, tasks, language = 'en') {
  const data = readIntegration(store), zh = language === 'zh';
  return tasks.map(task => {
    const notices = data.outbox.filter(n => n.task_id === task.id && !['api_accepted', 'cancelled'].includes(n.state));
    if (!notices.length) return task;
    const uncertain = notices.filter(n => n.state === 'delivery_unknown').length;
    const failed = notices.filter(n => ['api_error', 'dead'].includes(n.state)).length;
    const pending = notices.length - uncertain - failed;
    const parts = [];
    if (uncertain) parts.push(zh ? `通知送达待核查 ${uncertain}` : `Notification delivery unknown: ${uncertain}`);
    if (failed) parts.push(zh ? `通知失败 ${failed}` : `Notification failed: ${failed}`);
    if (pending) parts.push(zh ? `待发送通知 ${pending}` : `Notifications pending: ${pending}`);
    return {...task, notification_summary: parts.join('; ')};
  });
}
const writes = data => ({'integration.json': encode(data)});
function enqueue(data, eventId, route, doc, taskId = null, replyTo = null) {
  const noticeId = 'notice-' + digest([eventId, route]).slice(0, 40);
  if (data.outbox.some(n => n.id === noticeId)) return;
  data.outbox.push({id: noticeId, key: noticeId, event_id: eventId, task_id: taskId, route: structuredClone(route),
    document: doc, reply_to: replyTo, state: 'pending', attempts: 0, max_attempts: 3, available_at: stamp(),
    lease: null, intent: null, receipt: null, history: [], created_at: stamp()});
}
const routeFor = (connection, policy) => ({connector_id: connection.id, binding: connection.binding, policy_id: policy.id,
  account_id: policy.account, destination: {id: policy.destination, type: policy.destination_type ?? 'chat_id'}, format: policy.format});

// Store.save merges these writes with the task, projections, index and scheduler.
// No connector is loaded, no message is sent, and no source is polled in this hook.
export function taskNotificationWrites(store, task, previous) {
  const data = readIntegration(store), current = projection(task), prior = previous && projection(previous);
  if (prior && digest(prior) === digest(current)) return {};
  const kinds = [previous ? 'progress' : 'registered'];
  if (['blocked', 'failed', 'completed'].includes(task.status) && previous?.status !== task.status) kinds.push(task.status);
  if (prior ? digest(prior.checks) !== digest(current.checks) : current.checks.length) kinds.push('verification');
  if (prior && digest(prior.results) !== digest(current.results)) kinds.push('result');
  if (prior && digest(prior.execution) !== digest(current.execution)) kinds.push('execution');
  let changed = false;
  for (const watch of data.watches) {
    const connection = data.connections.find(c => c.id === watch.connector && c.enabled);
    if (!connection || !watch.enabled || !covers(watch.tasks, task.id) || !watch.events.some(k => kinds.includes(k))) continue;
    enqueue(data, `task:${task.id}:${task.revision}`, routeFor(connection, watch), document([task], watch.language), task.id);
    changed = true;
  }
  return changed ? writes(data) : {};
}

export function createIntegration({store, scheduler}) {
  const locked = fn => store.locked(() => { store.config(); return fn(); });
  const save = data => store.commit(writes(data));
  const publicNotice = n => ({id: n.id, event_id: n.event_id, task_id: n.task_id, route: n.route, state: n.state,
    attempts: n.attempts, available_at: n.available_at, receipt: n.receipt});
  function policyActive(data, notice) {
    const c = data.connections.find(c => c.id === notice.route.connector_id);
    const p = [...data.watches, ...data.grants].find(p => p.id === notice.route.policy_id && p.connector === c?.id);
    return c?.enabled && c.binding === notice.route.binding && p?.enabled && (!notice.task_id || covers(p.tasks, notice.task_id));
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
        if (n.state === 'sending') { n.receipt = sendResult(null, n.key); n.receipt.error_code = 'sender-interrupted'; finish(n); }
        else if (n.state === 'recorded') finish(n);
        else if (n.state === 'claimed') { n.state = n.attempts >= n.max_attempts ? 'dead' : 'pending'; n.lease = null; }
        changed = true;
      }
      let selected;
      for (const n of data.outbox) {
        if (n.state !== 'pending' || Date.parse(n.available_at) > Date.now()) continue;
        if (!policyActive(data, n)) { n.state = 'cancelled'; changed = true; continue; }
        n.state = 'claimed'; n.attempts++; n.lease = {consumer, token: crypto.randomUUID(), until: new Date(Date.now() + leaseMs).toISOString()};
        selected = structuredClone(n); changed = true; break;
      }
      if (changed) save(data); return selected ?? null;
    });
  }
  async function begin(noticeId, token, body) {
    return locked(() => {
      const data = readIntegration(store), n = getLease(data, noticeId, token);
      if (n.state !== 'claimed' || !policyActive(data, n)) throw new ConnectorError('Notification is not authorized for a new send');
      if (n.wire_body !== undefined && digest(n.wire_body) !== digest(body)) throw new ConnectorError('Retry payload must remain identical');
      n.wire_body = structuredClone(body); n.intent = {at: stamp(), attempt: n.attempts}; n.state = 'sending'; n.receipt = null;
      save(data); return structuredClone(n);
    });
  }
  async function record(noticeId, token, raw) {
    return locked(() => {
      const data = readIntegration(store), n = getLease(data, noticeId, token), result = sendResult(raw, n.key);
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
      let adapter, body;
      try {
        const c = await locked(() => readIntegration(store).connections.find(c => c.id === n.route.connector_id));
        ({adapter} = await bounded(() => loadConnector(c), 15000));
        body = n.wire_body ?? adapter.render(n.route.format, structuredClone(n.document));
        if (body === undefined || Buffer.byteLength(JSON.stringify(body)) > 28000) throw new ConnectorError('Notification render exceeds bounds');
      } catch {
        await record(n.id, n.lease.token, {status: 'not_sent', idempotency_key: n.key, retryable: false, error_code: 'adapter-preflight-failed'});
        sent.push(await ack(n.id, n.lease.token)); continue;
      }
      const intent = await begin(n.id, n.lease.token, body);
      let result;
      try {
        result = await bounded(signal => adapter[intent.reply_to ? 'reply' : 'send']({account_id: intent.route.account_id,
          destination: intent.route.destination, format: intent.route.format, body: intent.wire_body,
          reply_to: intent.reply_to, idempotency_key: intent.key}, {signal}));
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
      if (!data.grants.some(g => g.connector === c.id && g.enabled)) return null;
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
        const command = parseCommand(e), received = Date.parse(e.received_at), occurred = e.occurred_at === undefined ? received : Date.parse(e.occurred_at);
        const grant = data.grants.find(g => g.enabled && g.connector === snapshot.c.id && g.account === e.account_id && g.tenant === e.tenant_id &&
          g.tenant === e.sender_tenant_id && g.sender === e.sender_id && g.destination === e.destination_id && Number.isFinite(received) && Number.isFinite(occurred) && Math.min(received, occurred) >= Date.parse(g.since) &&
          command && g.commands.includes(command.verb) && (!command.task_id || covers(g.tasks, command.task_id)));
        if (cp) cp.cursor = e.cursor; else data.checkpoints.push({id: snapshot.c.id, cursor: e.cursor});
        if (seen) { save(data); return; }
        const entry = {id: messageKey, event_key: eventKey, connector: snapshot.c.id, status: 'rejected', reason: 'not-authorized-or-not-a-command'};
        data.inbox.push(entry);
        const currentConnection = data.connections.find(c => c.id === snapshot.c.id);
        if (!grant || !currentConnection.enabled || currentConnection.binding !== snapshot.c.binding) { save(data); return; }
        if (command.task_id && !store.index().some(t => t.id === command.task_id)) { entry.reason = 'unknown-task'; save(data); return; }
        if (['list', 'show'].includes(command.verb)) {
          const tasks = command.task_id ? [store.get(command.task_id)] : store.all().filter(t => covers(grant.tasks, t.id));
          enqueue(data, 'inbound:' + messageKey, routeFor(currentConnection, grant), document(tasks), command.task_id, grant.reply_mode === 'reply' ? e.message_id : null);
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
    if (args.command === 'start') {
      const timeout = args.timeout_ms === undefined ? 30000 : Number(args.timeout_ms);
      if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new ConnectorError('timeout-ms must be 0..60000');
      const deadline = performance.now() + timeout, consumer = args.consumer ?? 'dot-active';
      let ingested = 0; const notifications = [], gaps = [];
      do {
        const connections = await locked(() => readIntegration(store).connections.filter(c => c.enabled));
        for (const c of connections) {
          try { ingested += (await ingest({connector: c.id, limit: 100})).ingested; }
          catch { if (!gaps.includes(c.id)) gaps.push(c.id); }
        }
        notifications.push(...(await deliver({consumer, limit: args.limit ?? 10, lease_ms: args.lease_ms})).notifications);
        const queued = await scheduler.wait({command: 'wait', consumer, timeout_ms: Math.max(0, Math.min(1000, Math.round(deadline - performance.now()))), limit: args.limit ?? 1, lease_ms: args.lease_ms});
        if (queued.batch.length || ingested || notifications.length || gaps.length || performance.now() >= deadline) {
          return {...queued, ingested, notifications, receive_gaps: gaps, readiness: connections.length ? 'configured-bindings; live transport not attested' : 'local-only; no server binding'};
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
      if (cmd === 'connections') return data.connections;
      if (cmd === 'outbox') return data.outbox.filter(n => args.all || !['api_accepted', 'cancelled'].includes(n.state)).map(publicNotice);
      if (cmd === 'inbound') return {checkpoints: data.checkpoints, outcomes: data.inbox};
      if (['disconnect', 'unwatch', 'deny-inbound'].includes(cmd)) {
        const list = cmd === 'disconnect' ? data.connections : cmd === 'unwatch' ? data.watches : data.grants;
        const item = list.find(v => v.id === args.id); if (!item) throw new ConnectorError('Unknown binding');
        item.enabled = false; save(data); return {id: item.id, enabled: false};
      }
      if (cmd === 'watch' || cmd === 'allow-inbound') {
        const c = data.connections.find(c => c.id === args.connector && c.enabled); if (!c) throw new ConnectorError('Unknown or disabled connector');
        const p = {id: id(args.id), connector: c.id, account: requireText(args.account, 'account'), destination: requireText(args.destination, 'destination'),
          destination_type: args.destination_type ?? 'chat_id', format: args.format ?? 'card', tasks: taskScope(args.tasks), enabled: true};
        if (!['text', 'markdown', 'card'].includes(p.format)) throw new ConnectorError('Unsupported notification format');
        const requireOutbound = method => {
          if (!c.capabilities[method] || !c.capabilities.formats.includes(p.format)) throw new ConnectorError(`Requested format/${method} capability unavailable; choose an explicit supported format`);
        };
        let list;
        if (cmd === 'watch') {
          requireOutbound('send');
          p.events = csv(args.events, EVENTS); p.language = args.language ?? 'en'; if (!['en', 'zh'].includes(p.language)) throw new ConnectorError('Invalid language'); list = data.watches;
        } else {
          if (!c.capabilities.receive || !c.capabilities.durable_cursor) throw new ConnectorError('Durable inbox capability required');
          p.tenant = requireText(args.tenant, 'tenant'); p.sender = requireText(args.sender, 'sender'); p.commands = csv(args.commands, ['list', 'show', 'run', 'verify']);
          p.reply_mode = args.reply_mode ?? 'reply';
          if (!['reply', 'send'].includes(p.reply_mode)) throw new ConnectorError('Invalid reply mode');
          // Only list/show produce responses. Dispatch-only grants need no
          // outbound method or output format capability, including verify.
          if (p.commands.some(command => ['list', 'show'].includes(command))) requireOutbound(p.reply_mode);
          p.since = args.since ?? data.grants.find(g => g.id === p.id)?.since ?? stamp(); if (!Number.isFinite(Date.parse(p.since))) throw new ConnectorError('Invalid authorization start time'); list = data.grants;
        }
        const prior = list.find(v => v.id === p.id);
        if (prior && digest({...prior, enabled: true}) !== digest(p)) throw new ConnectorError('Policy identity is immutable; disable it and use a new ID to change scope');
        if (!prior && [...data.watches, ...data.grants].some(v => v.id === p.id)) throw new ConnectorError('Policy ID already exists');
        if (prior) prior.enabled = true; else list.push(p);
        if (cmd === 'watch' && args.initial && !prior) enqueue(data, 'initial:' + p.id, routeFor(c, p), document(store.all().filter(t => covers(p.tasks, t.id)), p.language));
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
        if (args.status === 'api_accepted') requireText(args.message_id, 'actual message ID');
        n.receipt = {status: args.status, idempotency_key: n.key, retryable: false, ...(args.message_id ? {message_id: args.message_id} : {})};
        n.history.push({at: stamp(), resolution: args.evidence}); finish(n);
      } else throw new ConnectorError('Unknown integration command');
      save(data); return publicNotice(n);
    });
  }
  return {run, claim, begin, record, ack, deliver, ingest};
}
