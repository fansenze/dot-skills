/** Durable scheduling inside the task store. No executor, daemon, or network API. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const SCHEDULER_OPTIONS = {
  bind: ['source', 'source-ref'], lookup: ['source', 'source-ref'],
  coverage: ['source', 'scope', 'state', 'evidence', 'observed-at'],
  schedule: ['event-id', 'request-id', 'source', 'source-ref', 'action', 'authorization-ref', 'work-revision', 'step-id', 'check-name', 'not-before', 'max-attempts'],
  queue: ['task-id', 'all'],
  wait: ['consumer', 'timeout-ms', 'lease-ms', 'limit', 'poll-ms'],
  'next-batch': ['consumer', 'lease-ms', 'limit'],
  begin: ['token'], renew: ['token', 'lease-ms'],
  record: ['token', 'source', 'run-id', 'state', 'source-version', 'evidence', 'observed-at', 'outcome'],
  ack: ['token'], nack: ['token', 'error-code', 'retry-after-ms'],
  resolve: ['token', 'evidence'],
  reschedule: ['reason'], unschedule: ['reason'],
};
export const SCHEDULER_IDS = ['bind', 'schedule', 'begin', 'renew', 'record', 'ack', 'nack', 'resolve', 'reschedule', 'unschedule'];
const STATES = ['queued', 'claimed', 'retry', 'done', 'dead', 'cancelled', 'blocked'];
const CLOSED = new Set(['done', 'cancelled']);
const ACTIONS = ['execute', 'observe', 'verify'];
const EXEC_STATES = ['unknown', 'queued', 'inProgress', 'completed', 'failed', 'interrupted', 'disconnected'];
const ERRORS = ['handler-failed', 'tool-unavailable', 'permission-denied', 'environment-failed', 'rate-limited', 'lease-expired'];
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const millis = () => Date.now();
const iso = n => new Date(n).toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
const mode = r => r.receipt ? 'ack' : r.intent ? 'reconcile' : 'execute';
const fresh = () => ({ schema_version: 1, events: [], requests: [], bindings: [], coverage: [] });

// Inject the existing store/model boundary rather than maintain another lock or
// another task implementation. All methods except wait run under Store.locked.
export function create_scheduler(core) {
  const { store, TaskError, encoded, read_json, nonempty, task_id, timestamp, timestamp_us,
    observed_time, newer_execution, now, event_record, display_time } = core;
  const fail = message => { throw new TaskError(message); };
  function text(value, field, max = 256) {
    const s = nonempty(value, field);
    if (s.length > max || /[\x00-\x1f\x7f]/.test(s)) fail(`${field} must be single-line text of at most ${max} characters`);
    return s;
  }
  function key(value, field) {
    const s = text(value, field, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(s)) fail(`${field} must be an opaque identifier (letters, digits, _, ., :, -)`);
    return s;
  }
  function integer(value, field, min, max, fallback) {
    const v = value === undefined ? fallback : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(v) || v < min || v > max) fail(`${field} must be an integer from ${min} to ${max}`);
    return v;
  }
  function choice(value, field, values) { if (!values.includes(value)) fail(`invalid ${field}; choose ${values.join(', ')}`); return value; }
  const identity = args => ({ source: key(args.source, 'source'), source_ref: text(args.source_ref, 'source-ref') });
  const binding = (data, ref) => data.bindings.find(b => b.source === ref.source && b.source_ref === ref.source_ref);
  const writes = data => ({ 'scheduler.json': encoded(data) });
  const save = (data, extraWrites = {}) => { validate(data); store.commit({...writes(data), ...extraWrites}); };
  const public_request = r => ({ ...r, lease: r.lease ? { consumer: r.lease.consumer, until: r.lease.until } : null, mode: mode(r), ack_token: undefined });

  function validate(data) {
    if (!object(data) || data.schema_version !== 1) fail('unsupported/invalid scheduler schema');
    for (const k of ['events', 'requests', 'bindings', 'coverage']) if (!Array.isArray(data[k])) fail(`invalid scheduler ${k}`);
    for (const name of ['events', 'requests']) {
      const ids = new Set();
      for (const row of data[name]) {
        if (!object(row)) fail(`invalid scheduler ${name}`);
        key(row.id, `${name} ID`);
        if (ids.has(row.id)) fail(`duplicate scheduler ${name} ID`);
        ids.add(row.id);
      }
    }
    const ids = new Set(data.requests.map(r => r.id));
    for (const e of data.events) { key(e.request_id, 'request ID'); timestamp(e.at); if (!ids.has(e.request_id)) fail('event refers to missing request'); }
    for (const r of data.requests) {
      const s = r.spec;
      if (!object(s)) fail('invalid scheduling specification');
      task_id(s.task_id); identity(s); choice(s.action, 'action', ACTIONS);
      text(s.authorization_ref, 'authorization-ref');
      integer(s.work_revision, 'work revision', 1, Number.MAX_SAFE_INTEGER);
      integer(s.max_attempts, 'max attempts', 1, 100);
      if (s.not_before !== null) timestamp(s.not_before);
      if (s.step_id !== null) key(s.step_id, 'step ID');
      if (s.check_name !== null) text(s.check_name, 'check name');
      if ((s.action === 'verify') !== (s.check_name !== null)) fail('verify requires a check name; other actions do not');
      choice(r.state, 'request state', STATES);
      integer(r.attempts, 'attempts', 0, Number.MAX_SAFE_INTEGER);
      integer(r.retry_limit, 'retry limit', 1, Number.MAX_SAFE_INTEGER);
      for (const k of ['created_at', 'updated_at', 'available_at']) timestamp(r[k]);
      if (!Array.isArray(r.resolutions)) fail('invalid reconciliation history');
      for (const resolution of r.resolutions) { timestamp(resolution.at); text(resolution.evidence, 'reconciliation evidence', 1000); }
      if (r.lease !== null) {
        if (!object(r.lease)) fail('invalid lease');
        key(r.lease.token, 'lease token'); key(r.lease.consumer, 'consumer'); timestamp(r.lease.until);
      }
      if ((r.state === 'claimed') !== (r.lease !== null)) fail('request/lease state mismatch');
      if (r.intent !== null) {
        if (!object(r.intent) || r.intent.request_id !== r.id) fail('invalid execution intent');
        timestamp(r.intent.at); integer(r.intent.attempt, 'intent attempt', 1, r.attempts);
      }
      if (r.receipt !== null) {
        if (!object(r.receipt) || !r.intent) fail('receipt requires an execution intent');
        key(r.receipt.source, 'result source'); text(r.receipt.run_id, 'execution reference');
        choice(r.receipt.state, 'execution state', EXEC_STATES); timestamp(r.receipt.observed_at); text(r.receipt.evidence, 'result evidence', 1000);
        if (r.receipt.source_version !== undefined) integer(r.receipt.source_version, 'source version', 1, Number.MAX_SAFE_INTEGER);
        if (s.action === 'verify') { choice(r.receipt.outcome, 'outcome', ['pass', 'fail']); if (r.receipt.check_id !== null) key(r.receipt.check_id, 'check ID'); }
        else if (r.receipt.outcome !== null || r.receipt.check_id !== null) fail('non-verification receipt contains a check');
      }
      if (r.state === 'done' && (!r.receipt || !r.ack_token)) fail('acknowledged request lacks a receipt');
      if (r.ack_token !== null) key(r.ack_token, 'ack token');
      if (typeof r.last_error !== 'string' || r.last_error.length > 1000) fail('invalid scheduling error');
      if (!data.events.some(e => e.request_id === r.id)) fail('request lacks a durable event');
    }
    const refs = new Set();
    for (const b of data.bindings) {
      const ref = identity(b), k = JSON.stringify(ref); task_id(b.task_id);
      if (refs.has(k)) fail('duplicate source binding'); refs.add(k);
    }
    const scopes = new Set();
    for (const c of data.coverage) {
      key(c.source, 'source'); text(c.scope, 'scope'); text(c.evidence, 'coverage evidence', 1000);
      choice(c.state, 'coverage', ['partial', 'complete', 'unavailable']); timestamp(c.observed_at);
      const k = JSON.stringify([c.source, c.scope]); if (scopes.has(k)) fail('duplicate discovery scope'); scopes.add(k);
    }
    return data;
  }
  function read() {
    const file = store.path('scheduler.json');
    return fs.existsSync(file) ? validate(read_json(file)) : fresh();
  }
  function inspect() {
    const data = read();
    for (const b of data.bindings) store.get(b.task_id);
    for (const r of data.requests) {
      const task = store.get(r.spec.task_id);
      if (r.spec.work_revision > task.work_revision) fail('schedule refers to a future work revision');
      if (r.spec.step_id && !task.steps.some(s => s.id === r.spec.step_id)) fail('schedule refers to a missing step');
      if (r.receipt?.check_id && !task.checks.some(c => c.id === r.receipt.check_id && c.name === r.spec.check_name && c.work_revision === r.spec.work_revision && c.outcome === r.receipt.outcome)) fail('schedule receipt/check mismatch');
    }
    return data;
  }
  function link(data, taskId, ref) {
    const old = binding(data, ref);
    if (old && old.task_id !== taskId) fail('source identity already belongs to another task; reconcile before binding');
    if (!old) data.bindings.push({ ...ref, task_id: taskId });
    return Boolean(old);
  }
  function register(args, taskFactory) {
    const data = read(), ref = identity(args), old = binding(data, ref);
    if (old) {
      if (args.id && args.id !== old.task_id) fail('source identity already belongs to another task');
      return store.get(old.task_id);
    }
    const task = taskFactory(); link(data, task.id, ref); validate(data);
    store.save(task, true, writes(data)); return task;
  }
  function eligible(r) {
    const task = store.get(r.spec.task_id);
    if (task.work_revision !== r.spec.work_revision) return 'Work changed; review and schedule a new request';
    if (r.spec.action === 'execute' && !['queued', 'executing'].includes(task.status)) return 'Task is not ready for execution';
    if (r.spec.action === 'verify' && task.status !== 'awaiting_verification') return 'Task is not awaiting verification';
    if (r.spec.step_id) {
      const step = task.steps.find(s => s.id === r.spec.step_id);
      if (!step) return 'Scheduled step no longer exists';
      if (r.spec.action === 'execute' && ['completed', 'skipped'].includes(step.state)) return 'Scheduled step is already resolved';
    }
    return null;
  }
  function request(data, id) { key(id, 'request ID'); return data.requests.find(r => r.id === id) || fail('unknown scheduling request'); }
  function leased(data, args) {
    const r = request(data, args.id); key(args.token, 'token');
    if (r.state !== 'claimed' || r.lease.token !== args.token || +timestamp(r.lease.until) <= millis()) fail('lease expired or token is stale; claim again and reconcile');
    return r;
  }
  function backoff(r) { return Math.min(60000, 1000 * 2 ** Math.min(6, r.attempts - 1)); }
  function retry(r, error, after) {
    r.state = r.attempts >= r.retry_limit && !r.receipt ? 'dead' : 'retry';
    r.last_error = error; r.lease = null; r.available_at = iso(millis() + after); r.updated_at = now();
  }
  function claim(args) {
    const consumer = key(args.consumer, 'consumer');
    const leaseMs = integer(args.lease_ms, 'lease-ms', 50, 3600000, 60000);
    const limit = integer(args.limit, 'limit', 1, 100, 10), data = read(), current = millis();
    let changed = false;
    for (const r of data.requests) {
      if (r.state === 'claimed' && +timestamp(r.lease.until) <= current) {
        retry(r, 'lease-expired', 0); r.available_at = iso(current); changed = true;
      }
    }
    const batch = [];
    // Stable arrival order among due requests; source timestamps do not reorder work.
    for (const r of data.requests) {
      if (batch.length >= limit) break;
      if (!['queued', 'retry'].includes(r.state) || +timestamp(r.available_at) > current) continue;
      // An existing intent must be reconciled even if the task changed meanwhile.
      const reason = r.intent ? null : eligible(r);
      if (reason) { r.state = 'blocked'; r.last_error = reason; r.updated_at = now(); changed = true; continue; }
      // Do not issue overlapping dispatches for the same task. In doubt, preserve
      // the unresolved intent until its result or non-creation is established.
      if (data.requests.some(other => other !== r && other.spec.task_id === r.spec.task_id &&
          (other.state === 'claimed' || (other.intent && !CLOSED.has(other.state))))) continue;
      r.state = 'claimed'; r.attempts++; r.updated_at = now();
      r.lease = { consumer, token: crypto.randomUUID(), until: iso(current + leaseMs) };
      batch.push({ ...public_request(r), token: r.lease.token }); changed = true;
    }
    if (changed) save(data);
    return batch;
  }
  async function wait(args) {
    const timeout = integer(args.timeout_ms, 'timeout-ms', 0, 60000, args.command === 'wait' ? 30000 : 0);
    const poll = integer(args.poll_ms, 'poll-ms', 20, 1000, 100);
    // Validate before acquiring/waiting and cap each lock wait by the deadline.
    key(args.consumer, 'consumer'); integer(args.lease_ms, 'lease-ms', 50, 3600000, 60000); integer(args.limit, 'limit', 1, 100, 10);
    const started = performance.now(), deadline = started + timeout, lockTimeout = store.timeout;
    let busy = false;
    do {
      store.timeout = Math.min(lockTimeout, Math.max(0.001, (deadline - performance.now()) / 1000));
      try {
        const batch = await store.locked(() => { store.config(); return claim(args); });
        busy = false;
        if (batch.length) return { batch, timed_out: false, waited_ms: Math.round(performance.now() - started) };
      } catch (error) {
        if (!(error instanceof TaskError) || !error.message.startsWith('store is busy;')) throw error;
        busy = true;
      } finally { store.timeout = lockTimeout; }
      if (performance.now() >= deadline) break;
      await delay(Math.min(poll, deadline - performance.now()));
    } while (true);
    return { batch: [], timed_out: true, reason: busy ? 'store-busy' : 'no-ready-events', waited_ms: Math.round(performance.now() - started) };
  }
  function execute(args, extraWrites = {}) {
    const data = read(), cmd = args.command;
    if (cmd === 'lookup') return binding(data, identity(args)) || null;
    if (cmd === 'bind') {
      store.get(args.id); const ref = identity(args), duplicate = link(data, args.id, ref);
      if (!duplicate) save(data); return { ...ref, task_id: args.id, duplicate };
    }
    if (cmd === 'coverage') {
      if (!args.source && !args.scope && !args.state && !args.evidence && !args.observed_at) return data.coverage;
      const c = { source: key(args.source, 'source'), scope: text(args.scope, 'scope'),
        state: choice(args.state, 'coverage', ['partial', 'complete', 'unavailable']),
        evidence: text(args.evidence, 'coverage evidence', 1000), observed_at: observed_time(args.observed_at) };
      const old = data.coverage.find(v => v.source === c.source && v.scope === c.scope);
      if (old && timestamp_us(c.observed_at) < timestamp_us(old.observed_at)) fail('older coverage observation rejected');
      if (old) Object.assign(old, c); else data.coverage.push(c);
      save(data); return c;
    }
    if (cmd === 'queue') {
      if (args.task_id) store.get(args.task_id);
      return data.requests.filter(r => (!args.task_id || r.spec.task_id === args.task_id) && (args.all || !CLOSED.has(r.state))).map(public_request);
    }
    if (cmd === 'schedule') {
      const id = key(args.request_id, 'request-id'), eventId = key(args.event_id, 'event-id'), ref = identity(args);
      const spec = { task_id: task_id(args.id), ...ref, action: choice(args.action, 'action', ACTIONS),
        authorization_ref: text(args.authorization_ref, 'authorization-ref'),
        work_revision: integer(args.work_revision, 'work-revision', 1, Number.MAX_SAFE_INTEGER),
        step_id: args.step_id === undefined ? null : key(args.step_id, 'step-id'),
        check_name: args.check_name === undefined ? null : text(args.check_name, 'check-name'),
        not_before: args.not_before === undefined ? null : iso(+timestamp(args.not_before)),
        max_attempts: integer(args.max_attempts, 'max-attempts', 1, 100, 5) };
      if ((spec.action === 'verify') !== (spec.check_name !== null)) fail('verify requires --check-name; other actions do not');
      const event = data.events.find(e => e.id === eventId), old = data.requests.find(r => r.id === id);
      if (event && event.request_id !== id) fail('event ID conflict; IDs cannot be reused');
      if (old && !same(old.spec, spec)) fail('request ID conflict; use the original specification or a new request ID');
      if (old) {
        if (!event) { data.events.push({ id: eventId, request_id: id, at: now() }); save(data, extraWrites); }
        else if (Object.keys(extraWrites).length) save(data, extraWrites);
        return { duplicate: true, event_id: eventId, request: public_request(old) };
      }
      const semantic = s => [s.task_id, s.source, s.source_ref, s.action, s.work_revision, s.step_id, s.check_name];
      const prior = data.requests.find(r => same(semantic(r.spec), semantic(spec)));
      if (prior) fail(`this source action is already scheduled as ${prior.id}; reuse its request ID`);
      const stamp = now(), r = { id, spec, state: 'queued', attempts: 0, retry_limit: spec.max_attempts,
        created_at: stamp, updated_at: stamp, available_at: spec.not_before || stamp,
        lease: null, intent: null, receipt: null, ack_token: null, last_error: '', resolutions: [] };
      const reason = eligible(r); if (reason) fail(reason);
      data.events.push({ id: eventId, request_id: id, at: stamp }); data.requests.push(r); save(data, extraWrites);
      return { duplicate: false, event_id: eventId, request: public_request(r) };
    }
    if (cmd === 'reschedule' || cmd === 'unschedule') {
      const r = request(data, args.id), reason = text(args.reason, 'reason', 1000);
      if (r.state === 'claimed' && +timestamp(r.lease.until) > millis()) fail('request has a live lease; coordinate with its consumer');
      if (CLOSED.has(r.state)) fail('request is already closed; use a new request for new work');
      if (cmd === 'unschedule' && r.intent) fail('reconcile and acknowledge the execution intent before cancelling');
      if (cmd === 'reschedule') {
        if (!r.intent) { const problem = eligible(r); if (problem) fail(problem); }
        r.state = 'retry'; r.available_at = now(); r.retry_limit = r.attempts + r.spec.max_attempts;
      } else r.state = 'cancelled';
      r.lease = null; r.last_error = reason; r.updated_at = now(); save(data); return public_request(r);
    }
    // Only the consumer holding an unexpired token may mutate an in-flight request.
    // Repeating the final acknowledgement with its original token is read-only.
    if (cmd === 'ack') {
      const done = request(data, args.id);
      if (done.state === 'done' && done.ack_token === args.token) return { acknowledged: true, duplicate: true, request_id: done.id };
    }
    const r = leased(data, args);
    if (cmd === 'renew') {
      r.lease.until = iso(millis() + integer(args.lease_ms, 'lease-ms', 50, 3600000, 60000));
    } else if (cmd === 'begin') {
      if (r.intent) return { proceed: false, mode: mode(r), request_id: r.id, receipt: r.receipt };
      const reason = eligible(r); if (reason) fail(reason);
      r.intent = { request_id: r.id, at: now(), attempt: r.attempts };
      r.updated_at = now(); save(data);
      return { proceed: true, mode: 'execute', request_id: r.id, idempotency_key: r.id };
    } else if (cmd === 'resolve') {
      if (!r.intent || r.receipt) fail('only an unresolved execution intent can be cleared');
      r.resolutions.push({ at: now(), evidence: text(args.evidence, 'evidence of no external execution', 1000) });
      r.intent = null;
      // No immediate dispatch: apply the same bounded retry policy.
      retry(r, 'confirmed-not-started', backoff(r));
    } else if (cmd === 'nack') {
      const error = choice(args.error_code, 'error-code', ERRORS);
      retry(r, error, integer(args.retry_after_ms, 'retry-after-ms', 0, 86400000, backoff(r)));
    } else if (cmd === 'record') {
      if (!r.intent) fail('persist begin before invoking an execution adapter');
      const applicable = r.spec.action === 'verify' && !eligible(r);
      const receipt = { source: key(args.source, 'source'), run_id: text(args.run_id, 'run-id'),
        state: choice(args.state, 'execution state', EXEC_STATES), evidence: text(args.evidence, 'evidence', 1000),
        observed_at: observed_time(args.observed_at || r.receipt?.observed_at),
        ...(args.source_version === undefined ? {} : { source_version: integer(args.source_version, 'source-version', 1, Number.MAX_SAFE_INTEGER) }),
        outcome: r.spec.action === 'verify' ? choice(args.outcome, 'outcome', ['pass', 'fail']) : null,
        check_id: r.receipt ? r.receipt.check_id : applicable ? 'check-' + crypto.createHash('sha256').update(r.id).digest('hex').slice(0, 24) : null };
      if (args.outcome !== undefined && r.spec.action !== 'verify') fail('--outcome requires a verification request');
      if (r.receipt) {
        if (!same(r.receipt, receipt)) fail('result already recorded; reconcile before changing facts');
        return { duplicate: true, request_id: r.id, receipt: r.receipt };
      }
      const task = store.get(r.spec.task_id);
      if (receipt.check_id) {
        if (timestamp_us(receipt.observed_at) < timestamp_us(task.updated_at)) fail('check predates latest task update');
        task.checks.push({ id: receipt.check_id, name: r.spec.check_name, outcome: receipt.outcome,
          evidence: receipt.evidence, at: receipt.observed_at, work_revision: r.spec.work_revision });
      }
      const observation = { state: receipt.state, observed_at: receipt.observed_at, source: receipt.source, run_id: receipt.run_id,
        ...(receipt.source_version === undefined ? {} : { source_version: receipt.source_version }) };
      if (newer_execution(task.execution, observation)) task.execution = observation;
      if (!task.last_checked_at || timestamp_us(receipt.observed_at) > timestamp_us(task.last_checked_at)) task.last_checked_at = receipt.observed_at;
      task.events.push(event_record('scheduling', `Scheduling result recorded: ${r.id}`, receipt.source, receipt.observed_at));
      task.revision++; task.updated_at = now();
      r.receipt = receipt; r.updated_at = now(); validate(data);
      // A result and its task evidence commit together, before ack or any notice.
      store.save(task, false, writes(data));
      return { duplicate: false, request_id: r.id, receipt };
    } else if (cmd === 'ack') {
      if (!r.receipt) fail('record the actual result before acknowledgement');
      r.state = 'done'; r.ack_token = r.lease.token; r.lease = null; r.last_error = '';
    } else fail('unknown scheduler command');
    r.updated_at = now(); save(data);
    return cmd === 'ack' ? { acknowledged: true, duplicate: false, request_id: r.id } : public_request(r);
  }
  function decorate(tasks, language = 'en') {
    const data = read(), zh = language === 'zh';
    const labels = zh ? { queued: '等待调度', claimed: '正在处理', retry: '等待重试', dead: '调度失败', blocked: '工作已变更，需重新安排' }
      : { queued: 'Scheduled', claimed: 'Processing', retry: 'Retry pending', dead: 'Scheduling failed', blocked: 'Work changed; review scheduling' };
    return tasks.map(task => {
      const active = data.requests.filter(r => r.spec.task_id === task.id && !CLOSED.has(r.state));
      if (!active.length) return task;
      const descriptions = active.map(r => {
        let label = r.intent && !r.receipt ? (zh ? '需要核对执行结果' : 'Execution needs reconciliation') : r.receipt ? (zh ? '结果已记录，等待确认' : 'Result recorded; acknowledgement pending') : labels[r.state];
        if (r.intent && !r.receipt && r.state === 'claimed' && r.intent.attempt === r.attempts && +timestamp(r.lease.until) > millis()) label = labels.claimed;
        if (!r.intent && eligible(r)) label = labels.blocked;
        if (r.state === 'queued' && +timestamp(r.available_at) > millis()) label += ' · ' + display_time(r.available_at);
        if (r.state === 'dead' || r.state === 'blocked') label += ': ' + r.last_error;
        return label;
      });
      return { ...task, scheduling_summary: [...new Set(descriptions)].join('; ') };
    });
  }
  return { read, inspect, register, execute, wait, decorate };
}
