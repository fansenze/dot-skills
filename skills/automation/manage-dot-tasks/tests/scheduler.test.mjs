/** Synthetic stores, adapters, and child processes only; no real platform calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import * as m from '../scripts/taskctl.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/taskctl.mjs', import.meta.url));
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const options = fields => Object.entries(fields).flatMap(([k, v]) => ['--' + k.replaceAll('_', '-'), String(v)]);
function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-scheduler-test-')), root = path.join(tmp, 'store');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const call = (...args) => m.run(m.parse_args(['--store', root, ...args.map(String)]));
  const init = () => call('init');
  const register = (id = 'task-example', fields = {}) => call('register', '--id', id, '--title', '用户原文', '--goal', 'Verified result', '--status', 'executing', ...options(fields));
  const scheduleArgs = (id = 'request-one', fields = {}, task = 'task-example') => ['schedule', task, ...options({
    request_id: id, event_id: 'event-' + id, source: 'conversation', source_ref: 'turn-' + id,
    action: 'execute', authorization_ref: 'synthetic-user-turn', work_revision: 1, ...fields,
  })];
  const schedule = (id, fields, task) => call(...scheduleArgs(id, fields, task));
  const batch = (fields = {}) => call('next-batch', ...options({ consumer: 'synthetic-dot', ...fields }));
  const record = (r, fields = {}) => call('record', r.id, '--token', r.token, ...options({
    source: 'mock-adapter', run_id: 'synthetic-run-' + r.id, state: 'completed', evidence: 'Synthetic adapter result', ...fields,
  }));
  const finish = async r => { await call('begin', r.id, '--token', r.token); await record(r); return call('ack', r.id, '--token', r.token); };
  const expire = id => new m.Store(root).locked(() => {
    const data = read(path.join(root, 'scheduler.json'));
    data.requests.find(r => r.id === id).lease.until = '2000-01-01T00:00:00.000000Z';
    new m.Store(root).commit({ 'scheduler.json': m.encoded(data) });
  });
  return { root, tmp, call, init, register, scheduleArgs, schedule, batch, record, finish, expire };
}
function child(t, root, args) {
  const process = spawn(globalThis.process.execPath, [SCRIPT, '--store', root, ...args.map(String)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); });
  let out = '', err = '';
  process.stdout.on('data', b => { out += b; }); process.stderr.on('data', b => { err += b; });
  const result = new Promise((resolve, reject) => {
    process.on('error', reject);
    process.on('close', (code, signal) => {
      if (code !== 0) return reject(new Error(`Child failed (${code ?? signal}): ${err}`));
      try { resolve(JSON.parse(out)); } catch { resolve(out); }
    });
  });
  return { process, result };
}

test('source identity intake is atomic and deduplicates concurrent discovery', async t => {
  const f = fixture(t); await f.init();
  const args = ['register', '--title', '原始任务', '--goal', 'Keep one record', '--source', 'local-host-one', '--source-ref', 'thread-one'];
  const tasks = await Promise.all(Array.from({ length: 12 }, () => child(t, f.root, args).result));
  assert.equal(new Set(tasks.map(v => v.id)).size, 1);
  assert.equal((await f.call('list', '--all')).length, 1);
  const reused = await f.call(...args, '--title', 'Should not overwrite observed facts');
  assert.equal(reused.title, '原始任务');
  await f.call('bind', reused.id, '--source', 'conversation', '--source-ref', 'commitment-one');
  assert.equal((await f.call('lookup', '--source', 'conversation', '--source-ref', 'commitment-one')).task_id, reused.id);
  await f.register('task-other');
  await assert.rejects(f.call('bind', 'task-other', '--source', 'conversation', '--source-ref', 'commitment-one'), /already belongs/);
  assert.equal((await f.call('doctor')).ok, true);
});

test('enqueue is durable before listening, idempotent by event and logical request', async t => {
  const f = fixture(t); await f.init(); await f.register();
  await Promise.all(Array.from({ length: 12 }, () => child(t, f.root, f.scheduleArgs()).result));
  let data = read(path.join(f.root, 'scheduler.json'));
  assert.equal(data.events.length, 1); assert.equal(data.requests.length, 1);
  assert.equal((await f.schedule('request-one', { event_id: 'event-retry' })).duplicate, true);
  await assert.rejects(f.schedule('request-one', { action: 'observe' }), /request ID conflict/);
  await assert.rejects(f.schedule('request-two', { event_id: 'event-request-one' }), /event ID conflict/);
  await assert.rejects(f.schedule('request-two', { source_ref: 'turn-request-one' }), /already scheduled/);
  const r = (await f.batch()).batch[0]; assert.equal(r.id, 'request-one');
  await f.finish(r);
  assert.equal((await f.schedule()).duplicate, true);
  assert.equal((await f.batch()).batch.length, 0);
  data = read(path.join(f.root, 'scheduler.json'));
  assert.equal(data.events.length, 2); assert.equal(data.requests[0].state, 'done');
  assert.equal((await f.call('show', 'task-example')).status, 'executing');
});

test('40 concurrent producers and concurrent consumers preserve every event and exclusive claim', async t => {
  const f = fixture(t); await f.init();
  for (let i = 0; i < 40; i++) await f.register('task-' + i);
  const producers = Array.from({ length: 40 }, (_, i) => child(t, f.root, f.scheduleArgs('request-' + i, {}, 'task-' + i)).result);
  const firstConsumers = Array.from({ length: 6 }, (_, i) => child(t, f.root, ['wait', '--consumer', 'consumer-' + i, '--timeout-ms', '1000', '--limit', '4']).result);
  await Promise.all(producers);
  const delivered = (await Promise.all(firstConsumers)).flatMap(v => v.batch);
  while (delivered.length < 40) {
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => child(t, f.root, ['next-batch', '--consumer', 'more-' + i, '--limit', '4']).result));
    const more = results.flatMap(v => v.batch); assert.ok(more.length, 'remaining ready requests must be returned'); delivered.push(...more);
  }
  assert.equal(delivered.length, 40); assert.equal(new Set(delivered.map(v => v.id)).size, 40);
  assert.equal(new Set(delivered.map(v => v.token)).size, 40);
  for (const r of delivered) await f.finish(r);
  const data = read(path.join(f.root, 'scheduler.json'));
  assert.equal(data.events.length, 40); assert.equal(data.requests.filter(r => r.state === 'done').length, 40);
  assert.equal((await f.call('doctor')).ok, true);
});

test('a waiter releases the store lock; events during processing and between waits survive', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.register('task-second');
  const waiter = child(t, f.root, ['wait', '--consumer', 'waiting-dot', '--timeout-ms', '2000']);
  await delay(100); await f.schedule();
  const first = (await waiter.result).batch[0]; assert.equal(first.id, 'request-one');
  await f.call('begin', first.id, '--token', first.token);
  await f.schedule('request-two', {}, 'task-second');
  await f.record(first); await f.call('ack', first.id, '--token', first.token);
  const second = (await f.call('wait', '--consumer', 'waiting-dot', '--timeout-ms', '500')).batch[0];
  assert.equal(second.id, 'request-two'); await f.finish(second);
});

test('bounded timeout can be rearmed and future schedules become due during the wait', async t => {
  const f = fixture(t); await f.init(); await f.register();
  let start = performance.now();
  const empty = await f.call('wait', '--consumer', 'dot', '--timeout-ms', '80', '--poll-ms', '20');
  assert.equal(empty.timed_out, true); assert.equal(empty.reason, 'no-ready-events'); assert.ok(performance.now() - start < 1500);
  await f.schedule('request-one', { not_before: new Date(Date.now() + 3000).toISOString() });
  assert.equal((await f.batch()).batch.length, 0);
  start = performance.now();
  const r = (await f.call('wait', '--consumer', 'dot', '--timeout-ms', '10000', '--poll-ms', '20')).batch[0];
  assert.equal(r.id, 'request-one'); await f.finish(r);
  assert.equal((await f.call('wait', '--consumer', 'dot', '--timeout-ms', '0')).timed_out, true);
});

test('busy-store wait respects its deadline and does not falsely claim the queue is empty', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  await new m.Store(f.root).locked(async () => {
    const start = performance.now(), out = await f.call('wait', '--consumer', 'dot', '--timeout-ms', '70');
    assert.equal(out.reason, 'store-busy'); assert.ok(performance.now() - start < 1000);
  });
  assert.equal((await f.batch()).batch.length, 1);
});

test('killing a waiting CLI and restarting does not lose queued events', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const waiter = child(t, f.root, ['wait', '--consumer', 'crashing-dot', '--timeout-ms', '30000']);
  const ended = assert.rejects(waiter.result, /Child failed/);
  await delay(120); waiter.process.kill('SIGKILL'); await ended;
  await f.schedule();
  const restart = await child(t, f.root, ['wait', '--consumer', 'new-dot', '--timeout-ms', '500']).result;
  assert.equal(restart.batch[0].id, 'request-one'); await f.finish(restart.batch[0]);
});

test('expired unstarted claims redeliver with a new token and reject stale workers', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  const first = (await f.batch({ lease_ms: 60 })).batch[0]; await delay(90);
  await assert.rejects(f.call('begin', first.id, '--token', first.token), /expired/);
  const second = (await f.batch()).batch[0]; assert.notEqual(second.token, first.token); assert.equal(second.mode, 'execute');
  await assert.rejects(f.call('ack', first.id, '--token', first.token), /stale/);
  await assert.rejects(f.call('renew', first.id, '--token', first.token), /stale/);
  await f.finish(second);
  assert.equal((await f.call('ack', second.id, '--token', second.token)).duplicate, true);
});

test('intent survives create-before-ack crash, repeated reconciliation, and unavailable queries', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  const external = new Map(); let createCount = 0;
  const first = (await f.batch()).batch[0];
  const permission = await f.call('begin', first.id, '--token', first.token); assert.equal(permission.proceed, true);
  external.set(permission.idempotency_key, 'synthetic-real-returned-id'); createCount++;
  assert.equal((await f.call('begin', first.id, '--token', first.token)).proceed, false);
  await f.expire(first.id); // Simulated consumer dies after side effect, before record/ack.
  const second = (await f.batch()).batch[0]; assert.equal(second.mode, 'reconcile');
  assert.equal((await f.call('begin', second.id, '--token', second.token)).proceed, false);
  await f.call('nack', second.id, '--token', second.token, '--error-code', 'tool-unavailable', '--retry-after-ms', '0');
  const third = (await child(t, f.root, ['next-batch', '--consumer', 'restarted-dot']).result).batch[0];
  assert.equal(third.mode, 'reconcile');
  assert.equal((await f.call('begin', third.id, '--token', third.token)).proceed, false);
  await f.record(third, { run_id: external.get(third.id) }); await f.call('ack', third.id, '--token', third.token);
  assert.equal(createCount, 1); assert.equal((await f.batch()).batch.length, 0);
  // Fencing cannot revoke side effects of an old worker. The persisted intent,
  // not ack rejection alone, kept the replacement from calling create again.
  await assert.rejects(f.record(first), /stale/);
});

test('receipt before ack survives lease expiry even when retry budget is exhausted', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule('request-one', { max_attempts: 1 });
  const first = (await f.batch()).batch[0];
  await f.call('begin', first.id, '--token', first.token);
  const result = await f.record(first); assert.equal(result.duplicate, false);
  const before = await f.call('show', 'task-example');
  assert.equal((await f.record(first)).duplicate, true);
  assert.deepEqual(await f.call('show', 'task-example'), before);
  await assert.rejects(f.record(first, { run_id: 'another-run' }), /already recorded/);
  await f.expire(first.id);
  const next = (await f.batch()).batch[0]; assert.equal(next.mode, 'ack');
  assert.equal((await f.call('begin', next.id, '--token', next.token)).proceed, false);
  await f.call('ack', next.id, '--token', next.token);
  assert.deepEqual(await f.call('show', 'task-example'), before);
});

test('failure retries are bounded, explicit reschedule preserves intent, and no-start resolution is separate', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule('request-one', { max_attempts: 1 });
  const first = (await f.batch()).batch[0]; await f.call('begin', first.id, '--token', first.token);
  await f.call('nack', first.id, '--token', first.token, '--error-code', 'environment-failed', '--retry-after-ms', '0');
  assert.equal((await f.call('queue'))[0].state, 'dead'); assert.equal((await f.batch()).batch.length, 0);
  await assert.rejects(f.call('unschedule', first.id, '--reason', 'Stop'), /reconcile/);
  await f.call('reschedule', first.id, '--reason', 'User approved another reconciliation attempt');
  const second = (await f.batch()).batch[0]; assert.equal(second.mode, 'reconcile');
  await f.call('resolve', second.id, '--token', second.token, '--evidence', 'Synthetic adapter authoritatively rejected before creation');
  const raw = read(path.join(f.root, 'scheduler.json')).requests[0];
  assert.equal(raw.intent, null); assert.equal(raw.resolutions.length, 1); assert.equal(raw.state, 'dead');
  await f.call('reschedule', first.id, '--reason', 'Retry confirmed unstarted work');
  const third = (await f.batch()).batch[0]; assert.equal(third.mode, 'execute'); await f.finish(third);
});

test('unstarted failure retries preserve delays and safe cancellation is explicit', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  const r = (await f.batch()).batch[0];
  await assert.rejects(f.call('ack', r.id, '--token', r.token), /record/);
  await assert.rejects(f.record(r), /begin/);
  await assert.rejects(f.call('unschedule', r.id, '--reason', 'Stop'), /live lease/);
  await f.call('nack', r.id, '--token', r.token, '--error-code', 'permission-denied', '--retry-after-ms', '10000');
  assert.equal((await f.batch()).batch.length, 0);
  await f.call('unschedule', r.id, '--reason', 'User cancelled pending work');
  assert.equal((await f.call('queue')).length, 0); assert.equal((await f.call('queue', '--all'))[0].state, 'cancelled');
});

test('lease renewal fences old tokens without falsely claiming continued tool availability', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  const r = (await f.batch({ lease_ms: 1000 })).batch[0];
  const renewed = await f.call('renew', r.id, '--token', r.token, '--lease-ms', '10000');
  assert.ok(Date.parse(renewed.lease.until) > Date.parse(r.lease.until));
  assert.equal((await f.batch()).batch.length, 0); await f.finish(r);
});

test('work revisions and resolved steps block obsolete schedules before dispatch', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const task = await f.call('step', 'task-example', '--title', 'Synthetic step');
  await f.schedule('request-one', { work_revision: task.work_revision, step_id: task.steps[0].id });
  await f.call('update', task.id, '--goal', 'Changed goal');
  assert.equal((await f.batch()).batch.length, 0); assert.equal((await f.call('queue'))[0].state, 'blocked');
  await assert.rejects(f.call('reschedule', 'request-one', '--reason', 'Retry'), /Work changed/);
  await f.call('unschedule', 'request-one', '--reason', 'Replace with current work');
  const revised = await f.call('show', task.id);
  await f.schedule('request-two', { work_revision: revised.work_revision, step_id: task.steps[0].id });
  const r = (await f.batch()).batch[0];
  await f.call('step', task.id, '--step-id', task.steps[0].id, '--state', 'completed', '--evidence', 'Synthetic step check');
  await assert.rejects(f.call('begin', r.id, '--token', r.token), /Work changed/);
});

test('same-task requests serialize and a dead unresolved intent blocks new dispatches', async t => {
  const f = fixture(t); await f.init(); await f.register();
  await f.schedule('request-one', { max_attempts: 1 }); await f.schedule('request-two');
  const first = await f.batch(); assert.equal(first.batch.length, 1);
  const r = first.batch[0]; await f.call('begin', r.id, '--token', r.token);
  await f.call('nack', r.id, '--token', r.token, '--error-code', 'handler-failed', '--retry-after-ms', '0');
  assert.equal((await f.batch()).batch.length, 0);
  await f.call('reschedule', r.id, '--reason', 'Inspect actual execution');
  const retry = (await f.batch()).batch[0]; assert.equal(retry.id, r.id);
  await f.record(retry); await f.call('ack', retry.id, '--token', retry.token);
  assert.equal((await f.batch()).batch[0].id, 'request-two');
});

test('scheduled check and receipt commit idempotently while task completion still requires acceptance', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const task = await f.call('update', 'task-example', '--status', 'awaiting_verification', '--reason', 'Work ready');
  await f.schedule('request-check', { action: 'verify', work_revision: task.work_revision, check_name: 'Acceptance' });
  const r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
  const receipt = await f.record(r, { outcome: 'pass' }); assert.ok(receipt.receipt.check_id);
  await f.record(r, { outcome: 'pass' }); await f.call('ack', r.id, '--token', r.token);
  const current = await f.call('show', task.id);
  assert.equal(current.checks.length, 1); assert.equal(current.status, 'awaiting_verification');
  const done = await f.call('complete', task.id, '--summary', 'Verified', '--evidence', 'Synthetic acceptance');
  assert.equal(done.status, 'completed'); assert.equal((await f.call('doctor')).ok, true);
});

test('failed scheduled checks block completion; results of superseded work cannot verify new work', async t => {
  const f = fixture(t); await f.init(); await f.register();
  let task = await f.call('update', 'task-example', '--status', 'awaiting_verification', '--reason', 'Ready');
  await f.schedule('request-fail', { action: 'verify', work_revision: task.work_revision, check_name: 'Acceptance' });
  let r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
  await f.record(r, { outcome: 'fail' }); await f.call('ack', r.id, '--token', r.token);
  await assert.rejects(f.call('complete', task.id, '--summary', 'Done', '--evidence', 'No'), /passing/);
  await f.schedule('request-stale', { action: 'verify', work_revision: task.work_revision, check_name: 'Acceptance' });
  r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
  task = await f.call('update', task.id, '--goal', 'New work');
  const result = await f.record(r, { outcome: 'pass' }); assert.equal(result.receipt.check_id, null);
  await f.call('ack', r.id, '--token', r.token);
  assert.equal((await f.call('show', task.id)).checks.length, 1);
  await assert.rejects(f.call('complete', task.id, '--summary', 'Done', '--evidence', 'No'), /passing/);
});

test('out-of-order execution results cannot regress the latest observed run (3, 1, 2)', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const base = Date.now() - 20000;
  for (const i of [3, 1, 2]) {
    await f.schedule('request-' + i, { action: 'observe' });
    const r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
    await f.record(r, { observed_at: new Date(base + i * 1000).toISOString(), run_id: 'run-' + i });
    await f.call('ack', r.id, '--token', r.token);
  }
  const task = await f.call('show', 'task-example');
  assert.equal(task.execution.run_id, 'run-3'); assert.equal(task.events.filter(e => e.kind === 'scheduling').length, 3);
  assert.equal(task.status, 'executing');
});

test('source versions prevent late older or unversioned snapshots from replacing newer facts', async t => {
  const f = fixture(t); await f.init(); await f.register();
  for (const version of [3, 1, 2]) {
    await f.schedule('request-' + version, { action: 'observe' });
    const r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
    await f.record(r, { source_version: version, run_id: 'same-external-task', state: version === 3 ? 'completed' : 'inProgress' });
    await f.call('ack', r.id, '--token', r.token);
  }
  const task = await f.call('show', 'task-example');
  assert.equal(task.execution.source_version, 3); assert.equal(task.execution.state, 'completed');
  await assert.rejects(f.call('observe', task.id, '--source', 'mock-adapter', '--run-id', 'same-external-task', '--state', 'inProgress'), /source version/);
  await assert.rejects(f.call('observe', task.id, '--source', 'mock-adapter', '--run-id', 'same-external-task', '--state', 'inProgress', '--source-version', '2'), /source version/);
  assert.equal((await f.call('show', task.id)).revision, task.revision);
});

test('transaction interruption recovers task, check, receipt and index together', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const task = await f.call('update', 'task-example', '--status', 'awaiting_verification', '--reason', 'Ready');
  await f.schedule('request-check', { action: 'verify', work_revision: task.work_revision, check_name: 'Acceptance' });
  const r = (await f.batch()).batch[0]; await f.call('begin', r.id, '--token', r.token);
  const commit = m.Store.prototype.commit;
  m.Store.prototype.commit = function (writes) {
    m.atomic_write(this.path('.transaction.json'), m.encoded({ schema_version: 1, writes }));
    const [relative, content] = Object.entries(writes)[0]; m.atomic_write(this.path(relative), content);
    throw new Error('Synthetic crash after first write');
  };
  try { await assert.rejects(f.record(r, { outcome: 'pass' }), /Synthetic crash/); }
  finally { m.Store.prototype.commit = commit; }
  assert.ok(fs.existsSync(path.join(f.root, '.transaction.json')));
  assert.equal((await child(t, f.root, ['doctor']).result).ok, true);
  assert.equal((await f.record(r, { outcome: 'pass' })).duplicate, true);
  assert.equal((await f.call('show', task.id)).checks.length, 1);
  await f.call('ack', r.id, '--token', r.token);
});

test('pending enqueue transaction is recovered before the next scan', async t => {
  const f = fixture(t); await f.init(); await f.register();
  const commit = m.Store.prototype.commit;
  m.Store.prototype.commit = function (writes) {
    m.atomic_write(this.path('.transaction.json'), m.encoded({ schema_version: 1, writes }));
    throw new Error('Synthetic producer crash before apply');
  };
  try { await assert.rejects(f.schedule(), /Synthetic producer crash/); }
  finally { m.Store.prototype.commit = commit; }
  assert.equal((await f.batch()).batch[0].id, 'request-one');
});

test('Markdown keeps three columns, escapes task text and shows scheduling without changing task facts', async t => {
  const f = fixture(t); await f.init(); const task = await f.register();
  await f.schedule('request-one', { not_before: '2099-01-01T00:00:00Z' });
  const list = await f.call('render', 'list'); assert.match(list, /Title \| Status \| Summary/); assert.match(list, /Scheduled/);
  assert.match(await f.call('render', 'detail', task.id), /Scheduled/);
  assert.match(await f.call('render', 'list', '--language', 'zh'), /等待调度/);
  assert.deepEqual(await f.call('show', task.id), task);
  const output = path.join(f.tmp, 'views'); await f.call('render', 'bundle', '--output', output);
  assert.match(fs.readFileSync(path.join(output, 'tasks', task.id + '.md'), 'utf8'), /Scheduled/);
  const data = read(path.join(f.root, 'scheduler.json')); assert.equal(data.events.length, 1);
  assert.equal(data.requests.length, 1); // UI and ledger edits never enqueue themselves.
});

test('discovery coverage is explicit and ordered; a bounded list does not become full coverage', async t => {
  const f = fixture(t); await f.init();
  assert.deepEqual(await f.call('coverage'), []);
  const current = new Date(Date.now() - 2000).toISOString();
  await f.call('coverage', '--source', 'local-host-one', '--scope', 'authorized-project', '--state', 'partial',
    '--evidence', 'Synthetic query returned 50 rows and no cursor', '--observed-at', current);
  await assert.rejects(f.call('coverage', '--source', 'local-host-one', '--scope', 'authorized-project', '--state', 'complete',
    '--evidence', 'Old response', '--observed-at', '2020-01-01T00:00:00Z'), /older/);
  assert.equal((await f.call('coverage'))[0].state, 'partial'); assert.deepEqual(await f.call('list'), []);
});

test('scheduler rejects shell payload options and unsafe bounds without side effects', async t => {
  const f = fixture(t); await f.init(); await f.register();
  assert.throws(() => m.parse_args(f.scheduleArgs().concat(['--command', 'arbitrary shell'])), /unrecognized/);
  for (const fields of [{ work_revision: 0 }, { max_attempts: 0 }, { request_id: '../../escape' }, { action: 'shell' }, { check_name: 'unexpected' }, { source_ref: 'line\nsecret' }]) {
    await assert.rejects(f.schedule('request-invalid', fields));
  }
  for (const args of [['wait', '--consumer', 'dot', '--timeout-ms', '60001'], ['next-batch', '--consumer', 'dot', '--lease-ms', '0'], ['next-batch', '--consumer', 'dot', '--limit', '0']]) await assert.rejects(f.call(...args));
  assert.ok(!fs.existsSync(path.join(f.root, 'scheduler.json')));
});

test('corrupt scheduler and internal symlink are rejected instead of resetting queued work', async t => {
  const f = fixture(t); await f.init(); await f.register(); await f.schedule();
  const file = path.join(f.root, 'scheduler.json'), original = fs.readFileSync(file);
  fs.writeFileSync(file, '{'); await assert.rejects(f.batch(), /valid JSON/);
  fs.writeFileSync(file, original);
  const bad = read(file); bad.requests[0].state = 'done'; fs.writeFileSync(file, m.encoded(bad));
  await assert.rejects(f.call('doctor'), /receipt/);
  const outside = path.join(f.tmp, 'outside'); fs.writeFileSync(outside, original); fs.unlinkSync(file); fs.symlinkSync(outside, file);
  await assert.rejects(f.batch(), /symlinks/); assert.deepEqual(fs.readFileSync(outside), original);
});
