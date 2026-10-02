/** Dependency-free behavioral tests. Every writable store is isolated; no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { package_skill } from '../scripts/package.mjs';
import * as m from '../scripts/taskctl.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/taskctl.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/python-schema1', import.meta.url));
const isoAgo = days => new Date(Date.now() - days * 86400000).toISOString();
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const text = file => fs.readFileSync(file, 'utf8');
const encoded = value => JSON.stringify(value, null, 2) + '\n';
const indexRow = task => Object.fromEntries(['id', 'title', 'status', 'updated_at'].map(key => [key, task[key]]));

function cli(root, args, ok = true) {
  const result = spawnSync(process.execPath, [SCRIPT, '--store', root, ...args.map(String)], {
    encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.ifError(result.error);
  if (!ok) {
    assert.notEqual(result.status, 0, result.stdout);
    return result.stderr;
  }
  assert.equal(result.status, 0, result.stderr);
  try { return JSON.parse(result.stdout); } catch { return result.stdout; }
}

function cliAsync(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, '--store', root, ...args.map(String)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`CLI exit ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch { resolve(stdout); }
    });
  });
}

function ledger(t, { initialize = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-tasks-node-test-'));
  const root = path.join(tmp, 'store');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const call = (...args) => cli(root, args);
  const fail = (...args) => cli(root, args, false);
  const register = fields => {
    const values = { id: 'task-example', title: '部署检查', goal: '得到经过核实的交付', status: 'executing', ...fields };
    return call('register', ...Object.entries(values).flatMap(([key, value]) => ['--' + key.replaceAll('_', '-'), value]));
  };
  const ready = () => {
    register();
    call('step', 'task-example', '--title', '实现', '--state', 'completed', '--evidence', '实现已检查');
    call('update', 'task-example', '--status', 'awaiting_verification', '--reason', '执行已结束，开始验收');
    call('check', 'task-example', '--name', '测试', '--outcome', 'pass', '--evidence', '12/12 tests passed');
  };
  const completed = () => {
    ready();
    return call('complete', 'task-example', '--summary', '验收完成', '--evidence', '测试通过');
  };
  if (initialize) call('init');
  return { tmp, root, call, fail, register, ready, completed };
}

function taskWrites(task) {
  const prefix = `tasks/${task.id}/`;
  return { [prefix + 'task.json']: encoded(task),
    ...Object.fromEntries(Object.entries(m.projections(task)).map(([name, content]) => [prefix + name, content])),
    'tasks.json': encoded([indexRow(task)]) };
}
function writeTask(root, task) {
  for (const [relative, content] of Object.entries(taskWrites(task))) {
    fs.writeFileSync(path.join(root, relative), content);
  }
}

// The original 38 ledger scenarios.
test('init is idempotent and preserves configuration', t => {
  const l = ledger(t);
  assert.equal(l.call('init', '--stale-hours', '1').initialized, false);
  assert.equal(json(path.join(l.root, 'store.json')).stale_hours, 24);
});

test('registration keeps the lightweight index and all projections', t => {
  const l = ledger(t), task = l.register();
  assert.deepEqual(Object.keys(l.call('list')[0]).sort(), ['id', 'title', 'status', 'updated_at'].sort());
  assert.equal(l.call('show', task.id).goal, '得到经过核实的交付');
  for (const name of ['task.json', 'goal.md', 'steps.md', 'events.jsonl', 'verification.md', 'results.md']) {
    assert.ok(fs.existsSync(path.join(l.root, 'tasks', task.id, name)));
  }
  assert.equal(l.call('verify').ok, true);
});

test('empty views and absent optional fields stay concise', t => {
  const l = ledger(t);
  assert.match(l.call('render', 'list'), /No tasks/);
  l.register();
  const detail = l.call('render', 'detail', 'task-example');
  assert.match(detail, /Next step not set/);
  for (const value of ['尚未核查', '还没有步骤', '尚无交付链接', '尚未验证', '暂无已记录阻塞', '$goal']) assert.ok(!detail.includes(value));
});

test('list and detail have distinct information density', t => {
  const l = ledger(t);
  l.register({ goal: 'GOAL-DETAIL-ONLY' });
  l.call('event', 'task-example', '--text', 'EVENT-DETAIL-ONLY');
  const list = l.call('render', 'list'), detail = l.call('render', 'detail', 'task-example');
  assert.ok(!list.includes('GOAL-DETAIL-ONLY'));
  assert.match(list, /EVENT/); assert.match(detail, /GOAL/); assert.match(detail, /EVENT/);
  assert.ok(list.includes('| Title | Status | Summary |'));
  assert.ok(!detail.includes('进展时间线')); assert.ok(!list.includes('查看任务'));
});

test('bundle links point to files actually generated', t => {
  const l = ledger(t); l.register();
  const out = path.join(l.tmp, 'ui'); l.call('render', 'bundle', '--output', out);
  assert.ok(text(path.join(out, 'index.md')).includes('tasks/task-example.md'));
  assert.ok(fs.existsSync(path.join(out, 'tasks/task-example.md')));
});

test('duplicate and path traversal task IDs are rejected', t => {
  const l = ledger(t); l.register();
  assert.match(l.fail('register', '--id', 'task-example', '--title', 'x', '--goal', 'y'), /already exists/);
  l.fail('register', '--id', '../../escape', '--title', 'x', '--goal', 'y');
});

test('blocked status requires a concrete blocker', t => {
  const l = ledger(t); l.fail('register', '--title', 'x', '--goal', 'y', '--status', 'blocked');
  l.register({ status: 'blocked', blocker: '连接不可用' }); assert.match(l.call('render', 'list'), /Blocked/);
});

test('illegal transitions and unverified completion are rejected', t => {
  const l = ledger(t); l.register({ status: 'queued' });
  l.fail('update', 'task-example', '--status', 'awaiting_verification', '--reason', '跳过执行');
  l.fail('update', 'task-example', '--status', 'executing');
  l.fail('complete', 'task-example', '--summary', '完成', '--evidence', '声称完成');
  l.fail('register', '--title', 'x', '--goal', 'y', '--status', 'completed');
});

test('execution-completed observation does not complete the task', t => {
  const l = ledger(t); l.register();
  const task = l.call('observe', 'task-example', '--state', 'completed', '--source', 'task API');
  assert.equal(task.status, 'executing'); assert.equal(task.completion, null);
  const detail = l.call('render', 'detail', 'task-example'); assert.ok(detail.includes('🚧')); assert.ok(!detail.includes('✅'));
});

test('inProgress observation does not claim live execution health', t => {
  const l = ledger(t); l.register(); l.call('observe', 'task-example', '--state', 'inProgress', '--source', 'API record');
  const detail = l.call('render', 'detail', 'task-example');
  assert.ok(!detail.includes('实时在线')); assert.ok(!detail.includes('状态说明'));
});

test('current passing evidence permits verified completion', t => {
  const l = ledger(t); l.ready();
  assert.equal(l.call('complete', 'task-example', '--summary', '已通过验收', '--evidence', '参见测试结果').status, 'completed');
  assert.equal(l.call('doctor').ok, true);
});

test('failing check blocks completion until the same check passes', t => {
  const l = ledger(t); l.ready();
  l.call('check', 'task-example', '--name', '安全检查', '--outcome', 'fail', '--evidence', '仍有问题');
  l.fail('complete', 'task-example', '--summary', '完成', '--evidence', 'e');
  l.call('check', 'task-example', '--name', '安全检查', '--outcome', 'pass', '--evidence', '问题已排除');
  l.call('complete', 'task-example', '--summary', '完成', '--evidence', '全部验收通过');
});

test('material updates invalidate prior acceptance checks', t => {
  const l = ledger(t); l.ready(); l.call('update', 'task-example', '--goal', '新目标');
  assert.match(l.fail('complete', 'task-example', '--summary', '完成', '--evidence', 'e'), /current passing/);
});

test('ordinary events preserve current acceptance checks', t => {
  const l = ledger(t); l.ready(); l.call('event', 'task-example', '--text', '补充说明');
  l.call('complete', 'task-example', '--summary', '完成', '--evidence', 'e');
});

test('unfinished steps and blockers prevent completion', t => {
  const l = ledger(t); l.register(); l.call('step', 'task-example', '--title', '待执行');
  l.call('update', 'task-example', '--status', 'awaiting_verification', '--reason', '准备验收');
  l.call('check', 'task-example', '--name', 'check', '--outcome', 'pass', '--evidence', 'e');
  l.fail('complete', 'task-example', '--summary', '完成', '--evidence', 'e');
  l.call('update', 'task-example', '--blocker', '仍有问题');
  l.call('check', 'task-example', '--name', 'check', '--outcome', 'pass', '--evidence', 'e');
  l.fail('complete', 'task-example', '--summary', '完成', '--evidence', 'e');
});

test('completed or skipped steps require supporting evidence', t => {
  const l = ledger(t); l.register();
  l.fail('step', 'task-example', '--title', 'test', '--state', 'completed');
  l.fail('step', 'task-example', '--title', 'test', '--state', 'skipped');
});

test('explicit reopen preserves history and invalidates completion', t => {
  const l = ledger(t); l.ready(); l.call('complete', 'task-example', '--summary', '完成', '--evidence', 'e');
  l.fail('update', 'task-example', '--goal', 'new');
  const reopened = l.call('update', 'task-example', '--status', 'executing', '--reason', '需求变更');
  assert.equal(reopened.completion, null); assert.equal(reopened.checks.length, 1); assert.deepEqual(m.current_checks(reopened), []);
});

test('optimistic revision conflict does not overwrite newer facts', t => {
  const l = ledger(t), first = l.register(); l.call('event', 'task-example', '--text', 'new');
  l.fail('update', 'task-example', '--title', 'stale', '--expected-revision', first.revision);
  assert.equal(l.call('show', 'task-example').title, first.title);
});

test('concurrent events never lose updates', async t => {
  const l = ledger(t); l.register();
  await Promise.all(Array.from({ length: 24 }, (_, i) => cliAsync(l.root, ['event', 'task-example', '--text', `event ${i}`])));
  const task = l.call('show', 'task-example'); assert.equal(task.events.length, 25); assert.equal(task.revision, 25);
  assert.equal(new Set(task.events.map(e => e.id)).size, 25); assert.equal(l.call('doctor').ok, true);
});

test('concurrent registrations preserve every lightweight index row', async t => {
  const l = ledger(t);
  await Promise.all(Array.from({ length: 16 }, (_, i) => cliAsync(l.root, ['register', '--id', `task-${String(i).padStart(3, '0')}`, '--title', String(i), '--goal', 'g'])));
  assert.equal(l.call('list').length, 16); assert.equal(l.call('doctor').ok, true);
});

test('interrupted transaction recovers authoritative and derived files', t => {
  const l = ledger(t), task = l.register();
  task.title = 'Recovered'; task.revision++; task.updated_at = new Date().toISOString();
  const writes = taskWrites(task);
  fs.writeFileSync(path.join(l.root, '.transaction.json'), encoded({ schema_version: 1, writes }));
  fs.writeFileSync(path.join(l.root, 'tasks/task-example/task.json'), writes['tasks/task-example/task.json']);
  assert.equal(l.call('show', 'task-example').title, 'Recovered'); assert.equal(l.call('doctor').ok, true);
  assert.ok(!fs.existsSync(path.join(l.root, '.transaction.json')));
});

test('malicious recovery journal cannot escape the store', t => {
  const l = ledger(t);
  fs.writeFileSync(path.join(l.root, '.transaction.json'), encoded({ schema_version: 1, writes: { '../escape': 'bad' } }));
  l.fail('list'); assert.ok(!fs.existsSync(path.join(l.tmp, 'escape')));
});

test('stale observations are labelled and older ones cannot replace newer ones', t => {
  const l = ledger(t); l.register();
  const task = l.call('observe', 'task-example', '--state', 'inProgress', '--source', 'old API snapshot', '--observed-at', isoAgo(2));
  assert.match(l.call('render', 'detail', 'task-example'), /update needed/);
  l.fail('observe', 'task-example', '--state', 'completed', '--source', 'older', '--observed-at', isoAgo(3));
  assert.deepEqual(l.call('show', 'task-example').execution, task.execution);
});

test('future and timezone-less observation times are rejected', t => {
  const l = ledger(t); l.register();
  for (const stamp of [isoAgo(-2), '2026-10-01T00:00:00', 'no date']) {
    l.fail('observe', 'task-example', '--state', 'inProgress', '--source', 'api', '--observed-at', stamp);
  }
});

test('acceptance check time must not predate the current task', t => {
  const l = ledger(t); l.register();
  l.fail('check', 'task-example', '--name', 'x', '--outcome', 'pass', '--evidence', 'y', '--checked-at', isoAgo(2));
});

test('dangerous links are rejected and Markdown is escaped', t => {
  const l = ledger(t); l.register({ title: '<script>bad</script> [click](javascript:bad)' });
  for (const url of ['javascript:alert(1)', 'https://user:pass@host/', 'file:///secret', 'https://a/\ntext']) {
    l.fail('result', 'task-example', '--label', 'bad', '--url', url);
  }
  const detail = l.call('render', 'detail', 'task-example'); assert.ok(!detail.includes('<script>')); assert.ok(!detail.includes('[click](javascript:'));
  l.call('result', 'task-example', '--label', 'Report', '--url', 'https://example.com/report(a)');
  assert.ok(l.call('render', 'detail', 'task-example').includes('report%28a%29'));
});

test('render output cannot overwrite the authoritative store', t => {
  const l = ledger(t); l.register(); l.fail('render', 'list', '--output', path.join(l.root, 'tasks.json'));
  assert.equal(l.call('doctor').ok, true);
});

test('symlink task records are rejected', t => {
  const l = ledger(t); l.register(); const target = path.join(l.root, 'tasks/task-example/task.json');
  fs.unlinkSync(target); fs.symlinkSync(path.join(l.root, 'store.json'), target); l.fail('show', 'task-example');
});

test('doctor detects projection and index corruption', t => {
  const l = ledger(t); l.register();
  fs.writeFileSync(path.join(l.root, 'tasks/task-example/steps.md'), 'changed'); l.fail('doctor');
  l.call('event', 'task-example', '--text', 'repair generated projections');
  const index = json(path.join(l.root, 'tasks.json')); index[0].title = 'different'; fs.writeFileSync(path.join(l.root, 'tasks.json'), encoded(index));
  l.fail('doctor');
});

test('active task blockers appear in the compact row without an attention section', t => {
  const l = ledger(t); l.register(); l.call('update', 'task-example', '--blocker', '部分连接待确认');
  const list = l.call('render', 'list'); assert.ok(list.includes('Blocked: 部分连接待确认')); assert.ok(!list.includes('需要关注'));
});

test('latest meaningful progress is not replaced by older execution observations', t => {
  const l = ledger(t); l.register(); l.call('event', 'task-example', '--kind', 'progress', '--text', 'CURRENT-EVENT');
  l.call('observe', 'task-example', '--state', 'unknown', '--source', 'OLD-SOURCE', '--observed-at', isoAgo(2));
  const detail = l.call('render', 'detail', 'task-example'); assert.match(detail, /CURRENT/); assert.ok(!detail.includes('OLD')); assert.ok(!detail.includes('时间线'));
});

test('dotdot render-output aliases cannot overwrite the store', t => {
  const l = ledger(t); l.register(); const out = path.join(l.tmp, 'out'); fs.mkdirSync(out);
  l.fail('render', 'list', '--output', out + '/../store/tasks.json');
  l.fail('render', 'bundle', '--output', out + '/../store'); assert.equal(l.call('doctor').ok, true);
});

test('dotdot store aliases keep the same output guard', t => {
  const l = ledger(t); const out = path.join(l.tmp, 'out'); fs.mkdirSync(out);
  cli(out + '/../store', ['render', 'list', '--output', path.join(l.root, 'tasks.json')], false);
  assert.equal(l.call('doctor').ok, true);
});

test('symlink render aliases cannot overwrite the store even before dotdot', t => {
  const l = ledger(t); l.register(); const alias = path.join(l.tmp, 'link'); fs.symlinkSync(l.root, alias, 'dir');
  l.fail('render', 'list', '--output', alias + '/tasks.json');
  l.fail('render', 'list', '--output', alias + '/../store/tasks.json'); assert.equal(l.call('doctor').ok, true);
});

test('a current failure is never hidden by many passing checks', t => {
  const l = ledger(t); l.ready(); l.call('check', 'task-example', '--name', 'CRITICAL', '--outcome', 'fail', '--evidence', 'must fix');
  for (let i = 0; i < 13; i++) l.call('check', 'task-example', '--name', `check-${i}`, '--outcome', 'pass', '--evidence', 'ok');
  assert.match(l.call('render', 'detail', 'task-example'), /CRITICAL/);
  assert.match(text(path.join(l.root, 'tasks/task-example/verification.md')), /CRITICAL/);
  l.fail('complete', 'task-example', '--summary', 'done', '--evidence', 'ok');
});

test('historical passing checks are clearly labelled in projections', t => {
  const l = ledger(t); l.ready(); l.call('update', 'task-example', '--goal', 'new goal');
  const projection = text(path.join(l.root, 'tasks/task-example/verification.md'));
  assert.ok(projection.includes('No current checks')); assert.ok(projection.includes('not used for current acceptance'));
});

test('completed views never show obsolete next actions', t => {
  const l = ledger(t); l.ready(); l.call('update', 'task-example', '--next-action', 'OBSOLETE-NEXT');
  l.call('check', 'task-example', '--name', 'final', '--outcome', 'pass', '--evidence', 'ok');
  assert.equal(l.call('complete', 'task-example', '--summary', 'done', '--evidence', 'ok').next_action, '');
  assert.ok(!l.call('render', 'list').includes('OBSOLETE')); assert.ok(!l.call('render', 'detail', 'task-example').includes('Next:'));
});

test('init never adopts or overwrites an unrecognized nonempty directory', t => {
  const l = ledger(t), other = path.join(l.tmp, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'unrelated.txt'), 'keep');
  cli(other, ['init'], false); assert.equal(text(path.join(other, 'unrelated.txt')), 'keep');
});

// Compact UI regression scenarios; these preserve the latest user-requested UI.
test('completed inactivity filtering changes at exactly ten minutes', t => {
  const l = ledger(t), task = l.completed(), start = m.timestamp(task.updated_at).getTime();
  assert.equal(m.visible_tasks([task], new Date(start + 599999)).length, 1);
  assert.deepEqual(m.visible_tasks([task], new Date(start + 600000)), []);
  assert.equal(m.visible_tasks([task], new Date(start + 600000), true).length, 1);
  assert.equal(task.status, 'completed');
});

test('later activity preserves the real completion timestamp', t => {
  const l = ledger(t), task = l.completed(), completedAt = task.completion.at;
  task.updated_at = new Date(m.timestamp(completedAt).getTime() + 7200000).toISOString();
  assert.equal(m.visible_tasks([task], new Date(m.timestamp(task.updated_at).getTime() + 599000)).length, 1);
  const status = m.status_cell(task);
  assert.equal(status, '✅ ' + m.display_time(completedAt)); assert.ok(!status.includes(m.display_time(task.updated_at)));
});

test('unfinished and failed tasks stay visible regardless of age', t => {
  const l = ledger(t), task = l.register(), current = new Date(m.timestamp(task.updated_at).getTime() + 300 * 86400000);
  for (const state of ['queued', 'executing', 'blocked', 'awaiting_verification', 'failed', 'cancelled']) {
    task.status = state; assert.equal(m.visible_tasks([task], current).length, 1, state);
  }
});

test('three-column Markdown escapes pipes, multiline content and HTML', t => {
  const l = ledger(t); l.register({ title: 'A|B\nC', summary: 'first|second\r\nthird <b>x</b>' });
  const rendered = l.call('render', 'list');
  assert.ok(rendered.includes('A\\|B · C')); assert.ok(rendered.includes('first\\|second · third &lt;b&gt;x&lt;/b&gt;'));
  const rows = rendered.split('\n').filter(line => line.startsWith('|')); assert.equal(rows.length, 3);
  assert.equal((rows[2].match(/(?<!\\)\|/g) || []).length, 4);
});

test('queued uses clock and active states have no completion time', t => {
  const l = ledger(t), task = l.register({ status: 'queued' }); assert.equal(m.status_cell(task), '🕒');
  task.status = 'executing'; assert.equal(m.status_cell(task), '🚧');
  task.status = 'awaiting_verification'; assert.equal(m.status_cell(task), '🚧');
});

test('short summary does not remove the full current blocker from detail', t => {
  const l = ledger(t); l.register({ status: 'blocked', blocker: 'Access approval needed; complete important request', summary: '等待访问批准' });
  const detail = l.call('render', 'detail', 'task-example');
  assert.ok(detail.includes('等待访问批准')); assert.ok(detail.includes('Access approval needed; complete important request'));
});

test('current failures remain visible alongside a concise summary', t => {
  const l = ledger(t); l.ready(); l.call('update', 'task-example', '--summary', '准备交付');
  l.call('check', 'task-example', '--name', 'CRITICAL', '--outcome', 'fail', '--evidence', 'must fix now');
  assert.match(l.call('render', 'list'), /CRITICAL/);
  const detail = l.call('render', 'detail', 'task-example'); assert.match(detail, /CRITICAL/); assert.match(detail, /must fix now/);
});

test('explicit Chinese labels do not translate original task content', t => {
  const l = ledger(t); l.register({ title: 'Original title 中文', summary: '原始进展 unchanged' });
  const en = l.call('render', 'list'), zh = l.call('render', 'list', '--language', 'zh');
  assert.ok(en.includes('# Tasks')); assert.ok(zh.includes('# 任务列表')); assert.ok(zh.includes('| 标题 | 状态 | 信息描述 |'));
  for (const output of [en, zh]) { assert.ok(output.includes('Original title 中文')); assert.ok(output.includes('原始进展 unchanged')); }
});

test('failed tasks retain summary, transition reason and useful remedy', t => {
  const l = ledger(t); l.register({ summary: 'Certificate expired', next_action: 'Renew the certificate' });
  l.call('update', 'task-example', '--status', 'failed', '--reason', 'HTTPS certificate expired');
  assert.ok(l.call('render', 'list').includes('Failed: Certificate expired'));
  const detail = l.call('render', 'detail', 'task-example'); assert.match(detail, /Certificate expired/); assert.match(detail, /Renew the certificate/);
  l.call('update', 'task-example', '--summary', ''); assert.match(l.call('render', 'list'), /HTTPS certificate expired/);
});

test('summary-only edits preserve current failed checks and work revision', t => {
  const l = ledger(t); l.ready();
  const before = l.call('check', 'task-example', '--name', 'Signature', '--outcome', 'fail', '--evidence', 'Signature invalid');
  const after = l.call('update', 'task-example', '--summary', 'Prepared package');
  assert.equal(after.work_revision, before.work_revision); assert.deepEqual(m.current_checks(after), m.current_checks(before));
  assert.match(l.call('render', 'list'), /Signature/); assert.match(l.call('render', 'detail', 'task-example'), /Signature invalid/);
  l.fail('complete', 'task-example', '--summary', 'done', '--evidence', 'ok');
});

test('clock UI does not change legacy step projections', t => {
  const l = ledger(t); l.register(); l.call('step', 'task-example', '--title', 'Queue step');
  assert.ok(text(path.join(l.root, 'tasks/task-example/steps.md')).includes('⬜'));
  assert.ok(l.call('render', 'detail', 'task-example').includes('🕒')); assert.equal(l.call('doctor').ok, true);
});

test('unsupported Node is rejected by the shared runtime guard', () => {
  assert.throws(() => m.require_node('16.0.0'), /Node\.js 22\.18/);
  assert.throws(() => m.require_node('22.17.9'), /Node\.js 22\.18/);
  assert.doesNotThrow(() => m.require_node('22.18.0'));
  assert.doesNotThrow(() => m.require_node('24.19.0'));
});

test('hidden completed records remain accessible and intact', t => {
  const l = ledger(t), task = l.completed(); task.created_at = '2020-01-01T00:00:00Z'; task.updated_at = '2020-01-02T00:00:00Z'; writeTask(l.root, task);
  assert.deepEqual(l.call('list'), []); assert.equal(l.call('list', '--all').length, 1);
  assert.match(l.call('render', 'list'), /No tasks/); assert.match(l.call('render', 'list', '--all'), /验收完成/);
  assert.deepEqual(l.call('show', 'task-example').completion, task.completion); assert.equal(l.call('doctor').ok, true);
});

// Additional migration-specific coverage.
test('frozen Python schema-1 store is readable without rewriting bytes', t => {
  const l = ledger(t, { initialize: false }); fs.cpSync(FIXTURE, l.root, { recursive: true });
  const before = new Map();
  function snapshot(dir) { for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = path.join(dir, ent.name); if (ent.isDirectory()) snapshot(name); else before.set(name, fs.readFileSync(name));
  } }
  snapshot(l.root);
  assert.equal(l.call('doctor').ok, true); const task = l.call('show', 'task-legacy');
  assert.equal(task.schema_version, 1); assert.equal(task.summary, undefined);
  assert.match(task.created_at, /\.\d{6}Z$/); assert.equal(task.checks.length, 2);
  l.call('render', 'list', '--all'); l.call('render', 'detail', 'task-legacy');
  for (const [file, content] of before) assert.deepEqual(fs.readFileSync(file), content, `read-only command changed ${path.relative(l.root, file)}`);
});

test('Node updates old Python schema records without losing history or precision', t => {
  const l = ledger(t, { initialize: false }); fs.cpSync(FIXTURE, l.root, { recursive: true });
  const before = l.call('show', 'task-legacy');
  const after = l.call('event', 'task-legacy', '--text', 'Node migration verified');
  assert.equal(after.created_at, before.created_at); assert.deepEqual(after.checks, before.checks);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  assert.deepEqual(after.execution, before.execution); assert.equal(after.revision, before.revision + 1);
  assert.equal(l.call('doctor').ok, true);
});

test('microsecond observation ordering preserves newer legacy evidence', t => {
  const l = ledger(t); l.register();
  l.call('observe', 'task-example', '--state', 'inProgress', '--source', 'newer legacy', '--observed-at', '2026-01-01T00:00:00.123999Z');
  l.fail('observe', 'task-example', '--state', 'failed', '--source', 'older legacy', '--observed-at', '2026-01-01T00:00:00.123001Z');
  assert.equal(l.call('show', 'task-example').execution.observed_at, '2026-01-01T00:00:00.123999Z');
});

test('a microsecond-older acceptance timestamp is rejected', t => {
  const l = ledger(t), task = l.register();
  task.created_at = '2026-01-01T00:00:00.000001Z';
  task.updated_at = '2026-01-01T00:00:00.123999Z'; writeTask(l.root, task);
  l.fail('check', 'task-example', '--name', 'old', '--outcome', 'pass', '--evidence', 'predates work', '--checked-at', '2026-01-01T00:00:00.123001Z');
  assert.deepEqual(l.call('show', 'task-example').checks, []);
});

test('dead owner recovery and transaction replay remain safe under contention', async t => {
  const l = ledger(t), task = l.register();
  const ended = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }); assert.equal(ended.status, 0);
  const token = `owner-${ended.pid}-${'a'.repeat(24)}.json`, lock = path.join(l.root, '.lock-node');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, token), encoded({ schema_version: 1, pid: ended.pid, hostname: os.hostname(), token }));
  task.title = 'Recovered concurrently'; task.revision++; task.updated_at = new Date().toISOString();
  fs.writeFileSync(path.join(l.root, '.transaction.json'), encoded({ schema_version: 1, writes: taskWrites(task) }));
  await Promise.all(Array.from({ length: 16 }, (_, i) => cliAsync(l.root, ['event', 'task-example', '--text', `recovery ${i}`])));
  const final = l.call('show', 'task-example'); assert.equal(final.title, 'Recovered concurrently');
  assert.equal(final.events.length, 17); assert.equal(final.revision, task.revision + 16); assert.equal(l.call('doctor').ok, true);
  assert.ok(!fs.existsSync(lock)); assert.ok(!fs.existsSync(path.join(l.root, '.transaction.json')));
});

test('a live owner is not stolen and lock timeout is bounded', async t => {
  const l = ledger(t), store = new m.Store(l.root, 1);
  await store.locked(async () => {
    const error = l.fail('--lock-timeout', '0.05', 'list'); assert.match(error, /busy/);
    assert.ok(fs.existsSync(path.join(l.root, '.lock-node')));
  });
  assert.ok(!fs.existsSync(path.join(l.root, '.lock-node'))); assert.equal(l.call('doctor').ok, true);
});

test('lock release between lstat and acquisition does not fail path resolution', async t => {
  const l = ledger(t), store = new m.Store(l.root), lock = path.join(store.root, '.lock-node');
  const token = `owner-${process.pid}-${'2'.repeat(24)}.json`;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, token), encoded({ schema_version: 1, pid: process.pid, hostname: os.hostname(), token }));
  const lstat = fs.lstatSync; let released = false, entered = false;
  fs.lstatSync = function (p, ...args) {
    const stat = lstat.call(this, p, ...args);
    if (p === lock && !released) {
      released = true;
      // Another owner finishes after this contender observed its directory.
      fs.unlinkSync(path.join(lock, token)); fs.rmdirSync(lock);
    }
    return stat;
  };
  try { await store.locked(() => { entered = true; }); }
  finally { fs.lstatSync = lstat; }
  assert.equal(released, true); assert.equal(entered, true);
  assert.ok(!fs.existsSync(lock)); assert.equal(l.call('doctor').ok, true);
});

test('lock owner disappearance after directory listing is retried safely', async t => {
  const l = ledger(t), store = new m.Store(l.root), lock = path.join(store.root, '.lock-node');
  const token = `owner-${process.pid}-${'3'.repeat(24)}.json`;
  fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, token), encoded({ schema_version: 1, pid: process.pid, hostname: os.hostname(), token }));
  const readdir = fs.readdirSync; let released = false, entered = false;
  fs.readdirSync = function (p, ...args) {
    const names = readdir.call(this, p, ...args);
    if (p === lock && !released) {
      released = true; fs.unlinkSync(path.join(lock, token)); fs.rmdirSync(lock);
    }
    return names;
  };
  try { await store.locked(() => { entered = true; }); }
  finally { fs.readdirSync = readdir; }
  assert.equal(released, true); assert.equal(entered, true); assert.ok(!fs.existsSync(lock));
});

for (const code of ['EACCES', 'EIO', 'ENOTDIR']) {
  test(`lock inspection preserves ${code} errors and existing owner data`, async t => {
    const l = ledger(t), store = new m.Store(l.root), lock = path.join(store.root, '.lock-node');
    const token = `owner-${process.pid}-${'4'.repeat(24)}.json`, owner = encoded({ schema_version: 1, pid: process.pid, hostname: os.hostname(), token });
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, token), owner);
    const lstat = fs.lstatSync; let entered = false;
    fs.lstatSync = function (p, ...args) {
      if (p === lock) throw Object.assign(new Error('Synthetic lock inspection error'), { code });
      return lstat.call(this, p, ...args);
    };
    try { await assert.rejects(store.locked(() => { entered = true; }), error => error.code === code); }
    finally { fs.lstatSync = lstat; }
    assert.equal(entered, false); assert.equal(text(path.join(lock, token)), owner);
  });
}

test('foreign-host locks are preserved instead of guessed stale', t => {
  const l = ledger(t), token = `owner-123-${'b'.repeat(24)}.json`, lock = path.join(l.root, '.lock-node');
  fs.mkdirSync(lock); const owner = encoded({ schema_version: 1, pid: 123, hostname: 'synthetic-other-host', token });
  fs.writeFileSync(path.join(lock, token), owner); l.fail('list'); assert.equal(text(path.join(lock, token)), owner);
});

test('invalid calendar dates and timezone offsets are rejected', t => {
  const l = ledger(t); l.register();
  for (const value of ['2026-02-30T00:00:00Z', '2026-01-01T25:00:00Z', '2026-01-01T00:00:00+24:00']) {
    l.fail('observe', 'task-example', '--state', 'unknown', '--source', 'invalid date', '--observed-at', value);
  }
});

test('explicit null text fields are invalid even when summary is optional', t => {
  const l = ledger(t), original = l.register();
  for (const field of ['blocker', 'next_action', 'summary']) {
    const corrupt = structuredClone(original); corrupt[field] = null; writeTask(l.root, corrupt);
    l.fail('show', 'task-example');
  }
  writeTask(l.root, original); assert.equal(l.call('doctor').ok, true);
});

test('English and Chinese render bytes match frozen Python views', () => {
  const task = json(path.join(FIXTURE, 'tasks/task-legacy/task.json'));
  const config = json(path.join(FIXTURE, 'store.json'));
  const expected = json(fileURLToPath(new URL('./fixtures/python-render-expected.json', import.meta.url)));
  const templates = fileURLToPath(new URL('../ui/', import.meta.url));
  const current = new Date(expected.current);
  for (const language of ['en', 'zh']) {
    assert.equal(m.render_list([task], config, text(path.join(templates, 'list.md')), false, current, false, language), expected[language].list);
    assert.equal(m.render_task(task, config, text(path.join(templates, 'task-detail.md')), current, language), expected[language].detail);
  }
});

test('init rejects unknown lookalike candidate directories without touching their contents', t => {
  const l = ledger(t, { initialize: false }); fs.mkdirSync(l.root);
  for (const name of ['.lock-candidate-anything', '.lock-candidate-' + 'c'.repeat(24)]) {
    const candidate = path.join(l.root, name); fs.mkdirSync(candidate);
    const evidence = path.join(candidate, 'user-data.txt'); fs.writeFileSync(evidence, 'do not adopt or overwrite');
    l.fail('init'); assert.equal(text(evidence), 'do not adopt or overwrite');
    assert.ok(!fs.existsSync(path.join(l.root, 'store.json')));
    fs.rmSync(candidate, { recursive: true });
  }
});

test('init rejects a syntactically named candidate with invalid owner metadata', t => {
  const l = ledger(t, { initialize: false }); fs.mkdirSync(l.root);
  const candidate = path.join(l.root, '.lock-candidate-' + 'd'.repeat(24)); fs.mkdirSync(candidate);
  const token = `owner-123-${'e'.repeat(24)}.json`, ownerFile = path.join(candidate, token);
  fs.writeFileSync(ownerFile, encoded({ schema_version: 1, pid: 123, hostname: os.hostname(), token: 'different-name' }));
  const before = fs.readFileSync(ownerFile); l.fail('init'); assert.deepEqual(fs.readFileSync(ownerFile), before);
  assert.ok(!fs.existsSync(path.join(l.root, 'store.json')));
});

test('a stale reaper cannot delete a newly acquired owner generation', async t => {
  const l = ledger(t), ended = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  assert.equal(ended.status, 0);
  const lock = path.join(fs.realpathSync.native(l.root), '.lock-node'), deadToken = `owner-${ended.pid}-${'f'.repeat(24)}.json`;
  const liveToken = `owner-${process.pid}-${'1'.repeat(24)}.json`, deadPath = path.join(lock, deadToken);
  fs.mkdirSync(lock); fs.writeFileSync(deadPath, encoded({ schema_version: 1, pid: ended.pid, hostname: os.hostname(), token: deadToken }));
  const unlink = fs.unlinkSync; let injected = false, entered = false;
  fs.unlinkSync = function (file) {
    const result = unlink(file);
    if (file === deadPath && !injected) {
      injected = true; fs.rmdirSync(lock); fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, liveToken), encoded({ schema_version: 1, pid: process.pid, hostname: os.hostname(), token: liveToken }));
    }
    return result;
  };
  try {
    await assert.rejects(new m.Store(l.root, 0.05).locked(async () => { entered = true; }), /busy/);
  } finally { fs.unlinkSync = unlink; }
  assert.equal(injected, true); assert.equal(entered, false);
  assert.deepEqual(fs.readdirSync(lock), [liveToken]); assert.equal(json(path.join(lock, liveToken)).pid, process.pid);
});

test('Node packaging is deterministic with valid per-entry CRC and original bytes', t => {
  const l = ledger(t, { initialize: false }), first = path.join(l.tmp, 'first.zip'), second = path.join(l.tmp, 'second.zip');
  const a = package_skill(first), b = package_skill(second);
  assert.equal(a.sha256, b.sha256); const zip = fs.readFileSync(first); assert.deepEqual(zip, fs.readFileSync(second));
  const source = path.dirname(path.dirname(SCRIPT)), names = []; let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const flags = zip.readUInt16LE(offset + 6), method = zip.readUInt16LE(offset + 8);
    const checksum = zip.readUInt32LE(offset + 14), packedSize = zip.readUInt32LE(offset + 18), size = zip.readUInt32LE(offset + 22);
    const nameLength = zip.readUInt16LE(offset + 26), extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength, bytes = zip.subarray(start, start + packedSize);
    assert.equal(flags & 0x800, 0x800); assert.equal(method, 0); assert.equal(size, packedSize); assert.equal(crc32(bytes), checksum);
    assert.ok(name.startsWith('manage-dot-tasks/')); assert.ok(!name.split('/').includes('..'));
    assert.deepEqual(bytes, fs.readFileSync(path.join(source, name.slice('manage-dot-tasks/'.length))));
    names.push(name); offset = start + packedSize;
  }
  assert.equal(zip.readUInt32LE(offset), 0x02014b50); assert.equal(names.length, a.files);
  assert.equal(new Set(names).size, names.length); assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), names.length);
  assert.ok(names.some(name => name.endsWith('/scripts/taskctl.mjs')));
  assert.ok(names.some(name => name.endsWith('/scripts/package.mjs')));
  assert.ok(names.includes('manage-dot-tasks/package.json'));
  assert.ok(!names.some(name => name.endsWith('/.gitignore') || name.endsWith('/pnpm-lock.yaml') || name.includes('/node_modules/')));
  assert.ok(!names.some(name => /\.py[cod]?$/.test(name) || name.includes('__pycache__')));
  assert.ok(!names.some(name => /\/tasks\.json$/.test(name) && !name.includes('/tests/fixtures/python-schema1/')));
});

test('package output cannot overwrite files inside the skill', t => {
  const source = path.dirname(path.dirname(SCRIPT)), target = path.join(source, 'SKILL.md'), before = fs.readFileSync(target);
  assert.throws(() => package_skill(target), /outside the skill/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test('links require an explicit scheme and authority instead of URL normalization', t => {
  const l = ledger(t); l.register();
  for (const url of ['http:foo', 'http:/foo', 'https:example.com', 'https:/example.com']) {
    l.fail('result', 'task-example', '--label', 'malformed', '--url', url);
  }
  assert.deepEqual(l.call('show', 'task-example').results, []);
});

test('recovery whitelist requires literal filenames and validates every write before applying any', t => {
  const l = ledger(t); l.register(); const indexPath = path.join(l.root, 'tasks.json'), before = fs.readFileSync(indexPath);
  for (const invalid of ['tasks/task-example/taskXjson', 'tasks/task-example/eventsXjsonl', 'tasks/task-example/task.json\n']) {
    fs.writeFileSync(path.join(l.root, '.transaction.json'), encoded({ schema_version: 1, writes: { 'tasks.json': '[]\n', [invalid]: 'unexpected content' } }));
    l.fail('list'); assert.deepEqual(fs.readFileSync(indexPath), before); assert.ok(!fs.existsSync(path.join(l.root, invalid)));
    fs.unlinkSync(path.join(l.root, '.transaction.json'));
  }
  assert.equal(l.call('doctor').ok, true);
});

// Use the default os.tmpdir() above, without rewriting TMPDIR: on macOS this
// exercises /var -> /private/var throughout the entire behavioral suite.
test('default stores use writable user locations locally and preserve the dot location', () => {
  const home = '/synthetic/home';
  assert.equal(m.default_store({ env: {}, platform: 'darwin', home, dot_shared: false }), home + '/Library/Application Support/manage-dot-tasks/task-store');
  assert.equal(m.default_store({ env: {}, platform: 'linux', home, dot_shared: true }), '/workspace/shared/dot-tools/task-store');
  assert.equal(m.default_store({ env: {}, platform: 'linux', home, dot_shared: false }), home + '/.local/share/manage-dot-tasks/task-store');
  assert.equal(m.default_store({ env: { XDG_DATA_HOME: '/synthetic/data' }, platform: 'linux', home, dot_shared: false }), '/synthetic/data/manage-dot-tasks/task-store');
  assert.equal(m.default_store({ env: { XDG_DATA_HOME: 'relative/data' }, platform: 'linux', home, dot_shared: false }), home + '/.local/share/manage-dot-tasks/task-store');
  assert.equal(m.default_store({ env: { DOT_TASKS_HOME: '/explicit/store' }, platform: 'linux', home, dot_shared: true }), '/explicit/store');
});

test('DOT_TASKS_HOME and explicit --store keep their precedence without writing a default store', t => {
  const l = ledger(t), envRoot = path.join(l.tmp, 'environment store');
  const invoke = args => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, DOT_TASKS_HOME: envRoot }, encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  assert.equal(invoke(['init']).store, fs.realpathSync.native(envRoot));
  assert.equal(invoke(['--store', l.root, 'init']).store, fs.realpathSync.native(l.root));
  assert.deepEqual(invoke(['list']), []);
});

test('the system /tmp alias supports new nested stores, rendering and packaging', t => {
  const tmp = fs.mkdtempSync('/tmp/dot-tasks-system-alias-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, '目录 with spaces', 'store');
  assert.equal(cli(root, ['init']).store, fs.realpathSync.native(root));
  cli(root, ['register', '--id', 'task-alias', '--title', 'Alias', '--goal', 'Verify native paths']);
  assert.equal(cli(root, ['list']).length, 1);
  const output = path.join(tmp, 'views', 'list.md');
  assert.equal(cli(root, ['render', 'list', '--output', output]).path, fs.realpathSync.native(output));
  assert.match(text(output), /Alias/);
  assert.match(cli(root, ['render', 'detail', 'task-alias']), /Alias/);
  assert.equal(cli(root, ['doctor']).ok, true);
  const zip = package_skill(path.join(tmp, 'archive', 'skill.zip'));
  assert.equal(zip.path, fs.realpathSync.native(path.join(tmp, 'archive', 'skill.zip')));
  assert.equal(fs.statSync(zip.path).size, zip.size_bytes);
});

test('store directory aliases share one ledger and one lock under contention', async t => {
  const l = ledger(t); l.register();
  const alias = path.join(l.tmp, 'store alias'); fs.symlinkSync(l.root, alias, 'dir');
  assert.equal(cli(alias, ['init']).store, fs.realpathSync.native(l.root));
  assert.equal(cli(alias, ['init']).initialized, false);
  await Promise.all(Array.from({ length: 8 }, (_, i) => cliAsync(i % 2 ? alias : l.root, ['event', 'task-example', '--text', `alias event ${i}`])));
  assert.equal(l.call('show', 'task-example').events.length, 9);
  await new m.Store(l.root).locked(async () => {
    assert.match(cli(alias, ['--lock-timeout', '0.05', 'list'], false), /busy/);
  });
  assert.equal(cli(alias, ['doctor']).ok, true);
});

test('output aliases resolve before dotdot and report the file actually written', t => {
  const l = ledger(t); l.register();
  const real = path.join(l.tmp, 'real'), nested = path.join(real, 'nested'), alias = path.join(l.tmp, 'output alias');
  fs.mkdirSync(nested, { recursive: true }); fs.symlinkSync(nested, alias, 'dir');
  const output = alias + '/../new directory/list.md';
  const rendered = l.call('render', 'list', '--output', output);
  assert.equal(rendered.path, fs.realpathSync.native(path.join(real, 'new directory/list.md')));
  assert.match(text(rendered.path), /部署检查/);
  assert.ok(!fs.existsSync(path.join(l.tmp, 'new directory')));
  const bundle = l.call('render', 'bundle', '--output', alias + '/../bundle');
  assert.equal(bundle.rendered, 2);
  assert.match(text(path.join(path.dirname(bundle.index), 'tasks/task-example.md')), /部署检查/);
  assert.equal(l.call('doctor').ok, true);
});

test('symlink then dotdot cannot bypass the authoritative-store output guard', t => {
  const l = ledger(t); l.register();
  const alias = path.join(l.tmp, 'escape'); fs.symlinkSync(path.join(l.root, 'tasks'), alias, 'dir');
  const before = fs.readFileSync(path.join(l.root, 'tasks.json'));
  assert.match(l.fail('render', 'list', '--output', alias + '/../tasks.json'), /outside the authoritative task store/);
  assert.match(l.fail('render', 'bundle', '--output', alias + '/..'), /outside the authoritative task store/);
  assert.deepEqual(fs.readFileSync(path.join(l.root, 'tasks.json')), before);
  assert.equal(l.call('doctor').ok, true);
});

test('dangling links, symlink cycles and non-directory parents fail without replacing anything', t => {
  const l = ledger(t), dangling = path.join(l.tmp, 'dangling'), loop = path.join(l.tmp, 'loop'), file = path.join(l.tmp, 'file');
  fs.symlinkSync(path.join(l.tmp, 'missing'), dangling); fs.symlinkSync('loop', loop); fs.writeFileSync(file, 'preserve');
  for (const output of [dangling, path.join(dangling, 'new.md'), loop, file + '/../new.md']) l.fail('render', 'list', '--output', output);
  assert.ok(fs.lstatSync(dangling).isSymbolicLink()); assert.ok(fs.lstatSync(loop).isSymbolicLink());
  assert.equal(text(file), 'preserve'); assert.ok(!fs.existsSync(path.join(l.tmp, 'missing'))); assert.ok(!fs.existsSync(path.join(l.tmp, 'new.md')));
});

for (const relative of ['store.json', 'tasks', '.transaction.json', '.lock-node']) {
  test(`store-internal symlink ${relative} stays rejected after resolving its root`, t => {
    const l = ledger(t); l.register();
    const target = path.join(l.root, relative), outside = path.join(l.tmp, 'outside');
    if (fs.existsSync(target)) fs.renameSync(target, outside);
    else if (relative === '.lock-node') fs.mkdirSync(outside);
    else fs.writeFileSync(outside, encoded({ schema_version: 1, writes: { 'tasks.json': '[]\n' } }));
    const directory = fs.statSync(outside).isDirectory();
    const before = directory ? fs.readdirSync(outside) : fs.readFileSync(outside);
    fs.symlinkSync(outside, target, directory ? 'dir' : 'file');
    assert.match(l.fail('list'), /symlinks/);
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.deepEqual(directory ? fs.readdirSync(outside) : fs.readFileSync(outside), before);
  });
}

test('case aliases cannot redirect rendering or packaging into authoritative files', t => {
  const l = ledger(t); l.register();
  const alternate = l.root.toUpperCase();
  if (!fs.existsSync(alternate) || fs.statSync(alternate).ino !== fs.statSync(l.root).ino) return t.skip('case-sensitive filesystem');
  assert.match(l.fail('render', 'list', '--output', path.join(alternate, 'TASKS.JSON')), /outside the authoritative task store/);
  assert.equal(l.call('doctor').ok, true);
  assert.throws(() => package_skill(path.join(path.dirname(SCRIPT), '..', 'SKILL.md').toUpperCase()), /outside the skill/);
});

test('package output aliases and dotdot cannot overwrite skill source', t => {
  const l = ledger(t, { initialize: false }), alias = path.join(l.tmp, 'source alias');
  fs.symlinkSync(path.dirname(SCRIPT), alias, 'dir');
  const target = path.join(path.dirname(SCRIPT), '..', 'SKILL.md'), before = fs.readFileSync(target);
  assert.throws(() => package_skill(alias + '/../SKILL.md'), /outside the skill/);
  assert.deepEqual(fs.readFileSync(target), before);
});

test('both CLI entry points execute through symlinked script paths', t => {
  const l = ledger(t), alias = path.join(l.tmp, 'entry.mjs');
  for (const [script, args] of [[SCRIPT, ['--store', l.root, 'doctor']], [path.join(path.dirname(SCRIPT), 'package.mjs'), [path.join(l.tmp, 'output.zip')]]]) {
    fs.symlinkSync(script, alias);
    const result = spawnSync(process.execPath, [alias, ...args], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    if (script === SCRIPT) assert.equal(output.ok, true);
    else assert.equal(output.path, fs.realpathSync.native(path.join(l.tmp, 'output.zip')));
    fs.unlinkSync(alias);
  }
});

test('first initialization distinguishes local readiness from unverified platform memory', t => {
  const l = ledger(t, { initialize: false }), result = l.call('init');
  assert.equal(result.initialized, true);
  assert.equal(result.initialization_scope, 'local_files_only');
  assert.equal(result.assistant_memory.status, 'not_checked');
  assert.equal(result.assistant_memory.handled_by, 'invoking_assistant');
  assert.ok(fs.existsSync(path.join(path.dirname(SCRIPT), '..', result.assistant_memory.workflow)));
  assert.deepEqual(fs.readdirSync(l.root).sort(), ['store.json', 'tasks.json']);
  assert.deepEqual(Object.keys(json(path.join(l.root, 'store.json'))).sort(), ['created_at', 'schema_version', 'snapshot_note', 'stale_hours']);
});

test('repeated initialization neither duplicates local setup nor claims a remembered convention', t => {
  const l = ledger(t); l.register();
  const config = fs.readFileSync(path.join(l.root, 'store.json')), task = l.call('show', 'task-example');
  for (let i = 0; i < 2; i++) {
    const result = l.call('init');
    assert.equal(result.initialized, false); assert.equal(result.assistant_memory.status, 'not_checked');
  }
  assert.deepEqual(fs.readFileSync(path.join(l.root, 'store.json')), config);
  assert.deepEqual(l.call('show', 'task-example'), task);
  assert.deepEqual(fs.readdirSync(l.root).sort(), ['store.json', 'tasks', 'tasks.json']);
});

test('local notes and forged flags never attest that platform memory was saved', t => {
  const l = ledger(t, { initialize: false });
  assert.equal(l.call('init', '--snapshot-note', 'Memory saved and verified').assistant_memory.status, 'not_checked');
  const configPath = path.join(l.root, 'store.json'), config = json(configPath);
  config.assistant_memory = { status: 'saved', verified: true };
  fs.writeFileSync(configPath, encoded(config));
  fs.writeFileSync(path.join(l.root, '.memory-saved'), 'true');
  assert.equal(l.call('init').assistant_memory.status, 'not_checked');
  assert.match(l.fail('init', '--memory-saved', 'true'), /unrecognized argument/);
  assert.equal(l.call('doctor').ok, true); // Local integrity is not a memory check.
});

test('new English tasks have English automatic events, projections and default views', t => {
  const l = ledger(t);
  l.register({ title: 'Release review', goal: 'Verify and deliver the release', status: 'queued' });
  l.call('update', 'task-example', '--status', 'executing', '--reason', 'Work started');
  l.call('step', 'task-example', '--title', 'Review changes', '--state', 'completed', '--evidence', 'Reviewed every change');
  l.call('observe', 'task-example', '--state', 'completed', '--source', 'Actual run result');
  l.call('result', 'task-example', '--label', 'Reviewed release', '--url', 'https://example.com/release');
  l.call('update', 'task-example', '--status', 'awaiting_verification', '--reason', 'Ready for final review');
  l.call('check', 'task-example', '--name', 'Acceptance', '--outcome', 'pass', '--evidence', 'Content and access checked');
  const task = l.call('complete', 'task-example', '--summary', 'Release delivered', '--evidence', 'Delivery and acceptance verified');
  for (const value of [encoded(task), l.call('render', 'list'), l.call('render', 'detail', task.id), ...Object.values(m.projections(task))]) {
    assert.doesNotMatch(value, /\p{Script=Han}/u);
  }
  assert.equal(task.events[0].text, 'Task registered');
  assert.ok(task.events.some(e => e.text.startsWith('Execution observation:')));
  assert.match(text(path.join(l.root, 'tasks/task-example/goal.md')), /^# Goal/);
  assert.equal(l.call('doctor').ok, true);
});

test('English output preserves user text and reads legacy status reasons', t => {
  const l = ledger(t), original = l.register({ title: '原文标题', goal: '原文目标', summary: '原文进度' });
  const task = l.call('update', original.id, '--status', 'failed', '--summary', '', '--reason', '失败原因：需要重试');
  assert.equal(task.title, original.title); assert.equal(task.goal, original.goal);
  assert.match(l.call('render', 'detail', original.id), /Failed: 失败原因：需要重试/);
  task.events.find(e => e.kind === 'status').text = '🔵 执行中 → 🔴 未达成：旧原因：保持原文';
  assert.equal(m.progress_summary(task), 'Failed: 旧原因：保持原文');
});

test('updating legacy projections uses English headings while retaining authoritative history', t => {
  const l = ledger(t, { initialize: false }); fs.cpSync(FIXTURE, l.root, { recursive: true });
  const before = l.call('show', 'task-legacy');
  assert.match(text(path.join(l.root, 'tasks/task-legacy/goal.md')), /^# 任务目标/);
  assert.equal(l.call('doctor').ok, true);
  const after = l.call('event', 'task-legacy', '--text', 'Current review recorded');
  assert.match(text(path.join(l.root, 'tasks/task-legacy/goal.md')), /^# Goal/);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
  for (const key of ['title', 'goal', 'checks', 'steps', 'results', 'execution']) assert.deepEqual(after[key], before[key]);
  assert.equal(l.call('doctor').ok, true);
});

test('integrity checks reject a mixture of legacy and English projection formats', t => {
  const l = ledger(t), task = l.register();
  fs.writeFileSync(path.join(l.root, 'tasks/task-example/goal.md'), m.projections(task, 'zh')['goal.md']);
  assert.match(l.fail('doctor'), /derived file mismatch/);
  l.call('event', task.id, '--text', 'Regenerate the complete projection set');
  assert.equal(l.call('doctor').ok, true);
});
