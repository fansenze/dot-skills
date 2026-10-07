#!/usr/bin/env node
import {selectTaskList} from './task-list.mjs';
import {createConversations, readConversations, CONVERSATION_OPTIONS, CONVERSATION_IDS} from './task-conversations.mjs';
import {uiTime, taskStatusLabel} from './presentation.mjs';
/** Dependency-free task management and scheduling. Node.js 22.18+; Linux/macOS. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { create_scheduler, SCHEDULER_OPTIONS, SCHEDULER_IDS } from './scheduler.mjs';
import { createIntegration, taskNotificationWrites, readIntegration, decorateNotifications, requestFailures, INTEGRATION_OPTIONS, INTEGRATION_IDS } from './integration.mjs';

export class TaskError extends Error {}
export function require_node(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) throw new TaskError(`Node.js 22.18 or newer is required; found ${version}`);
}
export const VERSION = 1;
export const STATES = ['queued', 'executing', 'blocked', 'awaiting_verification', 'completed', 'failed', 'cancelled'];
const TRANSITIONS = {queued:['executing','blocked','cancelled'], executing:['blocked','awaiting_verification','failed','cancelled'], blocked:['queued','executing','failed','cancelled','awaiting_verification'], awaiting_verification:['executing','blocked','failed','cancelled'], completed:['executing'], failed:['executing','cancelled'], cancelled:['queued','executing']};
const BADGES = {queued:'⚪ Queued',executing:'🔵 Executing',blocked:'🟠 Blocked',awaiting_verification:'🟣 Awaiting verification',completed:'✅ Verified complete',failed:'🔴 Failed',cancelled:'⚫ Cancelled'};
const STEP_STATES = ['queued','executing','completed','skipped'];
const STEP_BADGES = {queued:'⬜',executing:'🔵',completed:'✅',skipped:'➖'};
const UI_STEP_BADGES = {queued:'🕒',executing:'🚧',completed:'✅',skipped:'➖'};
const EXEC_STATES = ['unknown','queued','inProgress','completed','failed','interrupted','disconnected'];
const EXEC_LABELS = {unknown:'Unconfirmed',queued:'Queued',inProgress:'Recorded as in progress (not live health)',completed:'Turn ended (not task acceptance)',failed:'Execution failed',interrupted:'Execution interrupted',disconnected:'Execution environment disconnected'};
const TERMINAL = new Set(['completed','failed','cancelled']);
const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const uid = n => crypto.randomUUID().replaceAll('-','').slice(0,n);
export const now = () => new Date().toISOString().replace(/(\.\d{3})Z$/, '$1000Z');
export function timestamp(value) {
  if (typeof value !== 'string') throw new TaskError(`invalid timezone-aware timestamp: ${JSON.stringify(value)}`);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const d = new Date(value);
  if (!m || +m[1]<1 || !Number.isFinite(d.getTime()) || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>new Date(Date.UTC(+m[1],+m[2],0)).getUTCDate() || +m[4]>23 || +m[5]>59 || +m[6]>59 || (m[8]!=='Z' && (+m[8].slice(1,3)>23 || +m[8].slice(4)>59))) throw new TaskError(`invalid timezone-aware timestamp: ${JSON.stringify(value)}`);
  return d;
}
// Date is the rendering API; exact ordering retains schema-1 microseconds.
export function timestamp_us(value) {
  const milliseconds = BigInt(timestamp(value).getTime());
  const fraction = /\.(\d{1,6})/.exec(value)?.[1] || '';
  return milliseconds * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}
export function observed_time(value) {
  const d=timestamp(value || now());
  if (d.getTime()>Date.now()+5000) throw new TaskError('observation/check time cannot be in the future');
  // Retain microseconds from existing or explicit schema-1 observations.
  const fraction = value && /\.(\d{1,6})/.exec(value);
  return d.toISOString().replace(/\.\d{3}Z$/, '.'+(fraction ? fraction[1].padEnd(6,'0') : String(d.getUTCMilliseconds()).padStart(3,'0')+'000')+'Z');
}
export function newer_execution(previous, next) {
  if (previous.observed_at && timestamp_us(next.observed_at) < timestamp_us(previous.observed_at)) return false;
  if (previous.source === next.source && previous.run_id === next.run_id && previous.source_version !== undefined) {
    return next.source_version !== undefined && next.source_version > previous.source_version;
  }
  return true;
}
export function nonempty(value,field) { if(typeof value!=='string'||!value.trim()) throw new TaskError(`${field} must be nonempty text`); if(value.includes('\0')) throw new TaskError(`${field} contains NUL`); return value.trim(); }
export function task_id(value) { if(typeof value!=='string'||! /^[a-z][a-z0-9-]{2,63}$/.test(value)) throw new TaskError('ID must be 3–64 lowercase letters, digits or hyphens, starting with a letter'); return value; }
export function encoded(value) { return JSON.stringify(value,null,2)+'\n'; }
// Match schema-1 Python json.dumps separators in existing event projections.
function json_line(value) { if(Array.isArray(value)) return '['+value.map(json_line).join(', ')+']'; if(record(value)) return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+': '+json_line(v)).join(', ')+'}'; return JSON.stringify(value); }
export function read_json(p) { try { return JSON.parse(fs.readFileSync(p,'utf8')); } catch(e) { throw new TaskError(`cannot read valid JSON: ${path.basename(p)}: ${e.message}`); } }
function sync_dir(p) { const fd=fs.openSync(p,'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);} }
export function atomic_write(p,text) { fs.mkdirSync(path.dirname(p),{recursive:true}); const temp=path.join(path.dirname(p),'.write-'+uid(24)); let fd; try { fd=fs.openSync(temp,'wx',0o600); fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,p);sync_dir(path.dirname(p)); } finally {if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}} }
export function safe_md(value) { return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/([\\`*_{}\[\]()#+.!|>~-])/g,'\\$1').replaceAll('\n',' · '); }
export function safe_link(value) { value=nonempty(value,'link'); if(/[\x00-\x20\x7f<>"`\\]/.test(value))throw new TaskError('links must not contain whitespace, controls or Markdown/HTML delimiters'); if(!/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.test(value))throw new TaskError('link must have a host and must not contain credentials');let u;try{u=new URL(value);}catch{throw new TaskError('link must have a host and must not contain credentials');} if(!['https:','http:','oai-library:'].includes(u.protocol))throw new TaskError('result links must use https, http, or oai-library');if(!u.host||u.username||u.password)throw new TaskError('link must have a host and must not contain credentials');return value.replaceAll('(','%28').replaceAll(')','%29'); }
export const md_link=(label,url)=>`[${safe_md(label)}](${safe_link(url)})`;
export const event_record=(kind,text,source='',at=null)=>({id:'ev-'+uid(16),at:at||now(),kind,text:nonempty(text,'event text'),source});
export function current_checks(task) { const latest=new Map();for(const c of task.checks)if(c.work_revision===task.work_revision)latest.set(c.name,c);return [...latest.values()]; }
export function validate_task(t) {
  const required=['schema_version','id','title','goal','status','created_at','updated_at','revision','work_revision','last_checked_at','blocker','next_action','steps','events','checks','results','execution','completion'];
  if(!record(t)||required.some(k=>!has(t,k)))throw new TaskError('task record is missing required fields');
  if(t.schema_version!==VERSION)throw new TaskError('unsupported task schema version');task_id(t.id);for(const k of ['title','goal'])nonempty(t[k],k);if(!STATES.includes(t.status))throw new TaskError('invalid task status');
  for(const k of ['revision','work_revision'])if(!Number.isSafeInteger(t[k])||t[k]<1)throw new TaskError('invalid revision');
  for(const k of ['created_at','updated_at'])timestamp(t[k]);if(timestamp_us(t.updated_at)<timestamp_us(t.created_at))throw new TaskError('updated_at predates creation');if(t.last_checked_at!==null)timestamp(t.last_checked_at);
  for(const k of ['blocker','next_action','summary'])if(typeof(has(t,k)?t[k]:'')!=='string')throw new TaskError(`${k} must be text`);
  if(t.status==='blocked'&&!t.blocker.trim())throw new TaskError('blocked task requires a blocker');
  for(const k of ['steps','events','checks','results']) {if(!Array.isArray(t[k]))throw new TaskError(`${k} must be a list`);const ids=t[k].map(i=>record(i)?i.id:undefined);if(ids.some(i=>typeof i!=='string'||!i)||new Set(ids).size!==ids.length)throw new TaskError(`duplicate/invalid ${k} IDs`);}
  for(const s of t.steps){if(!STEP_STATES.includes(s.state))throw new TaskError('invalid step state');nonempty(s.title,'step title');if(['completed','skipped'].includes(s.state))nonempty(s.evidence,'step evidence/reason');}
  for(const e of t.events){timestamp(e.at);nonempty(e.text,'event text');}
  for(const c of t.checks){if(!['pass','fail'].includes(c.outcome))throw new TaskError('invalid check outcome');timestamp(c.at);nonempty(c.name,'check name');nonempty(c.evidence,'check evidence');if(!Number.isSafeInteger(c.work_revision)||c.work_revision<1||c.work_revision>t.work_revision)throw new TaskError('invalid check revision');}
  for(const r of t.results){nonempty(r.label,'result label');safe_link(r.url);}
  if(!record(t.execution)||!EXEC_STATES.includes(t.execution.state))throw new TaskError('invalid execution observation');if(t.execution.observed_at){timestamp(t.execution.observed_at);nonempty(t.execution.source,'execution source');}
  if(t.execution.source_version!==undefined&&(!Number.isSafeInteger(t.execution.source_version)||t.execution.source_version<1))throw new TaskError('invalid execution source version');
  if(t.status==='completed'){const c=t.completion;if(!record(c))throw new TaskError('completed task lacks completion record');timestamp(c.at);nonempty(c.summary,'completion summary');nonempty(c.evidence,'completion evidence');if(t.blocker||t.steps.some(s=>!['completed','skipped'].includes(s.state)))throw new TaskError('completed task contains unresolved work');const checks=current_checks(t);if(!checks.length||checks.some(c=>c.outcome!=='pass'))throw new TaskError('completed task lacks current passing verification');if(c.work_revision!==t.work_revision)throw new TaskError('completion refers to superseded work');}
}
export const index_row=t=>Object.fromEntries(['id','title','status','updated_at'].map(k=>[k,t[k]]));
function lex(a,b){return a<b?-1:a>b?1:0;}
const check_sort=(a,b)=>(a.outcome==='pass')-(b.outcome==='pass')||lex(a.name,b.name);
export const display_time=value=>value?timestamp(value).toISOString().slice(0,16).replace('T',' ')+' UTC':'Not checked';
const PROJECTION_LABELS = {
  en: { goal:'Goal', steps:'Steps', verification:'Verification', results:'Results', no_steps:'No steps recorded', no_results:'No result links recorded', unchecked:'⚪ Not verified; execution ending is not acceptance', current:'Current work verification', no_current:'⚪ No current checks; historical results do not verify this work', valid:'Current', revision:'Work revision', conclusion:'Acceptance conclusion:', history:n=>`History (latest ${Math.min(5,n)} of ${n}; not used for current acceptance)` },
  // Read compatibility for schema-1 projections. New writes always use English.
  zh: { goal:'任务目标', steps:'执行步骤', verification:'验证记录', results:'交付成果', no_steps:'尚未拆分步骤', no_results:'尚无交付链接', unchecked:'⚪ 尚未验证；执行结束不能代替验收', current:'当前工作版本的验收', no_current:'⚪ 当前工作尚无有效检查；历史结论不能替代本次验收', valid:'当前有效', revision:'工作版本', conclusion:'验收结论：', history:n=>`历史记录（最近 ${Math.min(5,n)} 项，共 ${n} 项；不用于本次完成判定）` }
};
export function verification_text(t, language='en') {
  const labels=PROJECTION_LABELS[language];
  if(!t.checks.length)return labels.unchecked;
  const active=current_checks(t),ids=new Set(active.map(c=>c.id)),history=t.checks.filter(c=>!ids.has(c.id));
  const parts=[`**${labels.current}**`];
  if(!active.length)parts.push(labels.no_current);
  for(const c of active.sort(check_sort))parts.push(`- ${c.outcome==='pass'?'✅':'❌'} **${safe_md(c.name)}** · ${labels.valid}\n  - ${display_time(c.at)} · ${safe_md(c.evidence)}`);
  if(history.length){
    parts.push(`\n**${labels.history(history.length)}**`);
    for(const c of history.sort((a,b)=>(timestamp_us(b.at)>timestamp_us(a.at)?1:timestamp_us(b.at)<timestamp_us(a.at)?-1:0)).slice(0,5))parts.push(`- ${c.outcome==='pass'?'✅':'❌'} ${safe_md(c.name)} · ${labels.revision} ${c.work_revision}\n  - ${display_time(c.at)} · ${safe_md(c.evidence)}`);
  }
  if(t.completion)parts.unshift(`**${labels.conclusion}** ${safe_md(t.completion.summary)}\n`);
  return parts.join('\n');
}
export function projections(t, language='en') {
  const labels=PROJECTION_LABELS[language];
  const steps=t.steps.map(s=>`- ${STEP_BADGES[s.state]} ${safe_md(s.title)}`+(s.evidence?` · ${safe_md(s.evidence)}`:'')).join('\n')||labels.no_steps;
  const results=t.results.map(r=>'- '+md_link(r.label,r.url)).join('\n')||labels.no_results;
  return {'goal.md':`# ${labels.goal}\n\n${safe_md(t.goal)}\n`,'steps.md':`# ${labels.steps}\n\n${steps}\n`,'events.jsonl':t.events.map(e=>json_line(e)+'\n').join(''),'verification.md':`# ${labels.verification}\n\n${verification_text(t,language)}\n`,'results.md':`# ${labels.results}\n\n${results}\n`};
}
function is_symlink(p) {try{return fs.lstatSync(p).isSymbolicLink();}catch(e){if(e.code==='ENOENT'||e.code==='ENOTDIR')return false;throw e;}}
export function canonical_path(value, { allow_symlinks = true } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TaskError('path must be nonempty text without NUL');
  if (value === '~' || value.startsWith('~/')) value = os.homedir() + value.slice(1);
  // Resolve existing components before processing ..; path.resolve and the JS
  // realpath implementation normalize it too early. Native realpath also gives
  // the actual spelling on case-insensitive disks. Missing tails may be created.
  const raw = path.isAbsolute(value) ? value : process.cwd() + path.sep + value;
  let resolved = path.parse(raw).root;
  const parts = raw.slice(resolved.length).split(path.sep);
  for (const [index, part] of parts.entries()) {
    if (!part || part === '.') continue;
    if (part === '..') { resolved = path.dirname(resolved); continue; }
    const candidate = path.join(resolved, part);
    let stat;
    try { stat = fs.lstatSync(candidate); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      resolved = candidate;
      continue;
    }
    if (stat.isSymbolicLink() && !allow_symlinks) throw new TaskError('store paths must not traverse symlinks');
    // Do not treat dangling/cyclic links as missing paths and replace them.
    resolved = fs.realpathSync.native(candidate);
    if (index < parts.length - 1 && !fs.statSync(resolved).isDirectory()) throw new TaskError('path component must be a directory');
  }
  return resolved;
}
export const is_main = url => Boolean(process.argv[1]) && canonical_path(process.argv[1]) === canonical_path(fileURLToPath(url));
function process_alive(pid) {if(!Number.isSafeInteger(pid)||pid<1)throw new TaskError('invalid lock owner; preserve store for inspection');try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;if(e.code==='EPERM')return true;throw e;}}
export class Store {
  constructor(root,timeout=10){this.root=canonical_path(root);this.timeout=timeout;}
  path(relative){if(path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw new TaskError('unsafe store path');return canonical_path(path.join(this.root,relative),{allow_symlinks:false});}
  async locked(fn,initialize=false){
    if(initialize)fs.mkdirSync(this.root,{recursive:true,mode:0o700});if(!fs.existsSync(this.root)||!fs.statSync(this.root).isDirectory())throw new TaskError('store does not exist; run init first');
    // The root is already canonical. The lock leaf is deliberately ephemeral:
    // resolving it through lstat -> realpath races with another owner's release.
    // Check its type in the acquisition loop without following the leaf.
    const lock=path.join(this.root,'.lock-node'),token=`owner-${process.pid}-${uid(24)}.json`,candidate=this.path('.lock-candidate-'+uid(24));
    fs.mkdirSync(candidate,{mode:0o700});fs.writeFileSync(path.join(candidate,token),encoded({schema_version:1,pid:process.pid,hostname:os.hostname(),token}),{mode:0o600,flag:'wx'});
    let acquired=false;const end=performance.now()+this.timeout*1000;
    try {
      for(;;){
        try {
          const stat=fs.lstatSync(lock);
          if(stat.isSymbolicLink())throw new TaskError('store paths must not traverse symlinks');
          if(!stat.isDirectory())throw new TaskError('invalid lock directory; preserve store for inspection');
        } catch(e) {if(e.code!=='ENOENT')throw e;}
        try{fs.renameSync(candidate,lock);acquired=true;break;}catch(e){if(!['EEXIST','ENOTEMPTY','EACCES'].includes(e.code))throw e;}
        // A complete owner directory is installed in one rename. A contender
        // removes only the dead owner's unique filename, never recursive rm.
        // rmdir cannot remove a newly acquired, nonempty generation.
        let names;try{names=fs.readdirSync(lock);}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(names.length===0){try{fs.rmdirSync(lock);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}continue;}
        if(names.length!==1||!/^owner-\d+-[a-f0-9]{24}\.json$/.test(names[0]))throw new TaskError('invalid lock directory; preserve store for inspection');
        const ownerPath=path.join(lock,names[0]);let owner;try{if(is_symlink(ownerPath))throw new TaskError('invalid lock owner symlink');owner=JSON.parse(fs.readFileSync(ownerPath,'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
        if(owner.token!==names[0]||owner.hostname!==os.hostname())throw new TaskError('lock owner is invalid or belongs to another host; shared multi-host stores are unsupported');
        if(!process_alive(owner.pid)){try{fs.unlinkSync(ownerPath);}catch(e){if(e.code!=='ENOENT')throw e;}try{fs.rmdirSync(lock);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}continue;}
        if(performance.now()>=end)throw new TaskError('store is busy; retry after the current writer finishes');await delay(20);
      }
      this.recover();return await fn();
    }finally{
      if(acquired){try{fs.unlinkSync(path.join(lock,token));}catch(e){if(e.code!=='ENOENT')throw e;}try{fs.rmdirSync(lock);}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))throw e;}}
      else{try{fs.unlinkSync(path.join(candidate,token));fs.rmdirSync(candidate);}catch(e){if(e.code!=='ENOENT')throw e;}}
    }
  }
  recover(){const journal=this.path('.transaction.json');if(!fs.existsSync(journal))return;const tx=read_json(journal);if(!record(tx)||tx.schema_version!==VERSION||!record(tx.writes))throw new TaskError('invalid recovery journal; preserve store for inspection');for(const [rel,content]of Object.entries(tx.writes)){if(!(['store.json','tasks.json','scheduler.json','integration.json','conversations.json'].includes(rel)||/^tasks\/[a-z][a-z0-9-]{2,63}\/(task\.json|goal\.md|steps\.md|events\.jsonl|verification\.md|results\.md)$/.test(rel))||typeof content!=='string')throw new TaskError('unsafe recovery journal; preserve store for inspection');this.path(rel);}for(const [rel,content]of Object.entries(tx.writes))atomic_write(this.path(rel),content);fs.unlinkSync(journal);this.sync_root();}
  sync_root(){sync_dir(this.root);}
  commit(writes){for(const rel of Object.keys(writes))this.path(rel);atomic_write(this.path('.transaction.json'),encoded({schema_version:VERSION,writes}));this.recover();}
  config(){const c=read_json(this.path('store.json'));if(!record(c)||c.schema_version!==VERSION)throw new TaskError('unsupported/invalid store schema');if(typeof c.stale_hours!=='number'||!Number.isFinite(c.stale_hours)||c.stale_hours<=0)throw new TaskError('stale_hours must be positive and finite');return c;}
  index(){const a=read_json(this.path('tasks.json'));if(!Array.isArray(a))throw new TaskError('tasks.json must be a JSON array');const ids=[];for(const r of a){if(!record(r)||Object.keys(r).sort().join()!==['id','status','title','updated_at'].join())throw new TaskError('invalid lightweight index row');task_id(r.id);nonempty(r.title,'index title');if(!STATES.includes(r.status))throw new TaskError('invalid index status');timestamp(r.updated_at);ids.push(r.id);}if(new Set(ids).size!==ids.length)throw new TaskError('duplicate index IDs');return a;}
  get(id){const t=read_json(this.path(`tasks/${task_id(id)}/task.json`));validate_task(t);if(t.id!==id)throw new TaskError('task directory and record ID differ');return t;}
  save(t,isNew=false,extraWrites={}){validate_task(t);let index=this.index();const present=index.some(r=>r.id===t.id);if(isNew&&(present||fs.existsSync(this.path(`tasks/${t.id}/task.json`))))throw new TaskError('task ID already exists');if(!isNew&&!present)throw new TaskError('task is missing from index; run doctor');index=index.filter(r=>r.id!==t.id).concat([index_row(t)]).sort((a,b)=>lex(a.id,b.id));const prefix=`tasks/${t.id}/`,writes={[prefix+'task.json']:encoded(t)};for(const[k,v]of Object.entries(projections(t)))writes[prefix+k]=v;writes['tasks.json']=encoded(index);this.commit({...writes,...taskNotificationWrites(this,t,isNew?null:this.get(t.id)),...extraWrites});}
  all(){return this.index().map(r=>{const t=this.get(r.id);if(['id','title','status','updated_at'].some(k=>r[k]!==t[k]))throw new TaskError('index/detail mismatch; run doctor');return t;});}
  selected(options={},scope=()=>true){return selectTaskList(this.index().filter(scope),options).map(r=>{const t=this.get(r.id);if(['id','title','status','updated_at'].some(k=>r[k]!==t[k]))throw new TaskError('index/detail mismatch; run doctor');return t;});}
  mutate(id,expected,fn,work=false){const t=this.get(id);if(expected!=null&&expected!==t.revision)throw new TaskError(`revision conflict: expected ${expected}, current ${t.revision}; re-read before retrying`);if(work&&t.status==='completed')throw new TaskError('reopen a completed task with update --status executing --reason before changing its work');fn(t);t.revision++;if(work){t.work_revision++;t.completion=null;}t.updated_at=now();this.save(t);return t;}
}
export function freshness(t,hours,current=new Date()){if(TERMINAL.has(t.status))return t.status==='completed'?'Completion evidence recorded':'Archived outcome';if(!t.last_checked_at)return '⚠️ Not checked';return current-timestamp(t.last_checked_at)>hours*3600000?`⚠️ Check is stale (over ${hours} hours)`:`Checked within ${hours} hours (not live status)`;}
export const last_check_label=t=>display_time(t.last_checked_at);
export function step_focus(t){if(t.status==='completed')return 'Verified complete; no pending steps';if(t.status==='cancelled')return 'Cancelled; no next step';for(const state of ['executing','queued']){const s=t.steps.find(s=>s.state===state);if(s)return s.title;}return t.next_action||(t.steps.length?'All steps recorded as finished':'Next step not set');}
export const UI_LABELS={en:{list_title:'Tasks',columns:['Title','Status','Summary'],empty:'No tasks',blocked:'Blocked',cancelled:'Cancelled',failed:'Failed',check_failed:'Verification failed',execution_failed:'Execution failed',execution_interrupted:'Execution interrupted',execution_disconnected:'Environment disconnected',observed:'observed',unplanned:'Next step not set',awaiting:'Checking results',recheck:'Reverification needed',goal:'Goal',next:'Next',last_checked:'Last checked',update_needed:'update needed',steps:'Steps',checks:'Checks',results:'Results'},zh:{list_title:'任务列表',columns:['标题','状态','信息描述'],empty:'暂无任务',blocked:'受阻',cancelled:'已取消',failed:'未达成',check_failed:'验证未通过',execution_failed:'执行失败',execution_interrupted:'执行中断',execution_disconnected:'执行环境断开',observed:'观察于',unplanned:'待安排下一步',awaiting:'正在核对结果',recheck:'需重新验收',goal:'目标',next:'下一步',last_checked:'最近核查',update_needed:'需更新',steps:'步骤',checks:'验证',results:'结果'}};
export function visible_tasks(tasks,current=new Date(),include_all=false){return selectTaskList(tasks,{all:include_all});}
export const status_cell=(t,language='en')=>taskStatusLabel(t,language);
function newest(events){return events.reduce((a,b)=>!a||timestamp_us(b.at)>timestamp_us(a.at)?b:a,null);}
function status_reason(events){const text=newest(events.filter(e=>e.kind==='status'))?.text||'';const separator=/[:：]/.exec(text);return separator?text.slice(separator.index+1).trimStart():'';}
export function latest_progress(t){return newest(t.events.filter(e=>['progress','note','decision'].includes(e.kind)))?.text||'';}
export function progress_summary(t,language='en'){if(t.status==='completed')return [t.completion.summary,t.scheduling_summary,t.notification_summary].filter(Boolean).join('; ');const ui=UI_LABELS[language],parts=[],concise=(t.summary||'').trim();if(['cancelled','failed'].includes(t.status)){const explanation=concise||status_reason(t.events)||latest_progress(t);parts.push(ui[t.status]+(explanation?': '+explanation:''));}if(t.blocker)parts.push(ui.blocked+': '+(concise||t.blocker));const failures=current_checks(t).filter(c=>c.outcome==='fail');if(failures.length)parts.push(ui.check_failed+': '+failures.map(c=>c.name).join(', '));const ex=t.execution;if(['failed','interrupted','disconnected'].includes(ex.state))parts.push(ui['execution_'+ex.state]+' ('+ui.observed+' '+display_time(ex.observed_at)+')');if(!parts.length)parts.push(concise||latest_progress(t)||t.steps.find(s=>s.state==='executing')?.title||t.next_action||ui.unplanned);if(t.status==='awaiting_verification'&&!failures.length)parts.push(ui.awaiting);if(t.scheduling_summary)parts.push(t.scheduling_summary);if(t.notification_summary)parts.push(t.notification_summary);return [...new Set(parts)].join('; ');}
export const table_cell=v=>safe_md(String(v).replace(/\r\n?/g,'\n'));
export function compact_verification(t,language='en'){const ui=UI_LABELS[language],checks=current_checks(t);if(!checks.length)return t.checks.length?'- '+ui.recheck:t.status==='awaiting_verification'?'- '+ui.awaiting:'';return checks.sort(check_sort).map(c=>`- ${c.outcome==='pass'?'✅':'❌'} ${safe_md(c.name)}：${safe_md(c.evidence)}`).join('\n');}
function substitute(template,values){return template.replace(/\$\$|\$\{([^}]+)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)|\$/g,(full,a,b)=>{if(full==='$$')return '$';const key=a||b;if(!key||!has(values,key))throw new TaskError(`invalid or unknown template placeholder: ${full}`);return values[key];});}
export function render_task(t,config,template,current=new Date(),language='en'){const ui=UI_LABELS[language],summary=progress_summary(t,language),sections=[];if(t.blocker&&!summary.includes(t.blocker))sections.push(ui.blocked+': '+safe_md(t.blocker));if(t.goal!==summary&&t.goal!==t.title)sections.push(ui.goal+': '+safe_md(t.goal));if(!['completed','cancelled'].includes(t.status)&&t.next_action&&t.next_action!==summary)sections.push(ui.next+': '+safe_md(t.next_action));if(!TERMINAL.has(t.status)&&t.execution.observed_at&&current-timestamp(t.execution.observed_at)>config.stale_hours*3600000)sections.push(ui.last_checked+': '+uiTime(t.execution.observed_at)+', '+ui.update_needed);if(t.steps.length)sections.push('## '+ui.steps+'\n\n'+t.steps.map(s=>`- ${UI_STEP_BADGES[s.state]} ${safe_md(s.title)}`+(s.state==='skipped'&&s.evidence?' · '+safe_md(s.evidence):'')).join('\n'));const v=compact_verification(t,language);if(v)sections.push('## '+ui.checks+'\n\n'+v);if(t.results.length)sections.push('## '+ui.results+'\n\n'+t.results.map(r=>'- '+md_link(r.label,r.url)).join('\n'));return substitute(template,{title:safe_md(t.title),id:t.id,updated_at:uiTime(t.updated_at),status_badge:status_cell(t,language),summary:summary===t.title?'':safe_md(summary),sections:sections.join('\n\n'),footer:(t.status==='completed'?(language==='zh'?'完成于：':'Completed: '):(language==='zh'?'更新于：':'Updated: '))+uiTime(t.status==='completed'?t.completion.at:t.updated_at)+' · Asia/Shanghai'}).trimEnd()+'\n';}
export function render_list(tasks,config,template,link_details=false,current=new Date(),include_all=false,language='en') {
  const ui=UI_LABELS[language],zh=language==='zh',rank={blocked:0,executing:1,awaiting_verification:2,queued:3,completed:4,failed:5,cancelled:6};
  const selected=visible_tasks(tasks,current,include_all).sort((a,b)=>rank[a.status]-rank[b.status]),groups=new Map();
  for(const t of selected){if(!groups.has(t.status))groups.set(t.status,[]);groups.get(t.status).push(t);}
  const sections=[...groups.values()].map(group=>{
    const entries=group.map(t=>{
      const title=link_details?`[${table_cell(t.title)}](tasks/${t.id}.md)`:table_cell(t.title);
      return `**${title}**\n\n${table_cell(progress_summary(t,language))}`;
    });
    return `## ${status_cell(group[0],language)} · ${group.length}\n\n`+entries.join('\n\n');
  });
  const footer=(zh?'核对于：':'Checked: ')+uiTime(current.toISOString())+' · Asia/Shanghai';
  const scope=include_all?(zh?'本次展示全部本地任务。':'All local task records shown.'):(zh?`本次展示 ${selected.length} 个活跃任务 · 最近更新优先，最多 10 项`:`Showing ${selected.length} active tasks · most recently updated, at most 10`);
  return substitute(template,{list_title:ui.list_title,generated_at:uiTime(current.toISOString()),tasks:sections.length?sections.join('\n\n---\n\n'):ui.empty,footer,coverage:scope}).trimEnd()+'\n';
}
export function write_output(p,content,store){const target=canonical_path(p),relative=path.relative(store.root,target);if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw new TaskError('render outputs must be outside the authoritative task store');atomic_write(target,content);return target;}

const COMMAND_OPTIONS={
  init:['stale-hours','snapshot-note'],register:['id','title','goal','status','blocker','next-action','summary','source','source-ref'],
  update:['title','goal','blocker','next-action','summary','reason','status','expected-revision'],
  step:['step-id','title','state','evidence','expected-revision'],event:['text','kind','source','expected-revision'],
  observe:['state','source','observed-at','run-id','source-version','expected-revision'],check:['name','outcome','evidence','checked-at','expected-revision'],
  result:['label','url','expected-revision'],complete:['summary','evidence','expected-revision'],
  list:['status','all'],show:[],render:['output','all','language','templates'],doctor:[],verify:[],...SCHEDULER_OPTIONS,...INTEGRATION_OPTIONS,...CONVERSATION_OPTIONS
};
const DEFAULT_TEMPLATES=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../ui');
export function help(command) {
  const first='taskctl — task management and scheduling (Node.js 22.18+)\n';
  if(command&&has(COMMAND_OPTIONS,command))return first+`Usage: node taskctl.mjs [--store PATH] ${command}${['update','step','event','observe','check','result','complete','show',...SCHEDULER_IDS,...INTEGRATION_IDS,...CONVERSATION_IDS].includes(command)?' ID':command==='render'?' list|detail|bundle [ID]':''} [options]\nOptions: `+COMMAND_OPTIONS[command].map(o=>'--'+o).join(', ')+'\n'+(['list','render'].includes(command)?'Default lists show the 10 most recently updated active tasks. --all includes history; list --status explicitly selects a state.\n':'')+'See references/cli.md for required fields and examples.\n';
  return first+'Usage: node taskctl.mjs [--store PATH] [--lock-timeout SECONDS] COMMAND [options]\nCommands: '+Object.keys(COMMAND_OPTIONS).join(', ')+'\nUse COMMAND --help for command options.\n';
}
export function default_store({ env = process.env, platform = process.platform, home = os.homedir(), dot_shared = fs.existsSync('/workspace/shared') } = {}) {
  if (env.DOT_TASKS_HOME) return env.DOT_TASKS_HOME;
  if (platform === 'linux' && dot_shared) return '/workspace/shared/dot-tools/task-store';
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'manage-dot-tasks', 'task-store');
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(data, 'manage-dot-tasks', 'task-store');
}
export function parse_args(argv=process.argv.slice(2)) {
  const args={store:default_store(),lock_timeout:10};let i=0;
  function option(allowed){const raw=argv[i++],eq=raw.indexOf('='),key=raw.slice(2,eq<0?undefined:eq);if(!allowed.includes(key))throw new TaskError(`unrecognized argument: ${raw}`);let value;if(['all','initial','allow-new','updates','all-senders'].includes(key)){if(eq>=0)throw new TaskError(`--${key} does not take a value`);value=true;}else{value=eq>=0?raw.slice(eq+1):argv[i++];if(value===undefined||value.startsWith('--'))throw new TaskError(`--${key} requires a value`);}args[key.replaceAll('-','_')]=value;}
  while(i<argv.length&&argv[i].startsWith('-')){if(['--help','-h'].includes(argv[i]))return {...args,help:help()};option(['store','lock-timeout']);}
  args.command=argv[i++];if(!has(COMMAND_OPTIONS,args.command))throw new TaskError('a valid command is required; use --help');
  const positional=[];while(i<argv.length){if(['--help','-h'].includes(argv[i]))return {...args,help:help(args.command)};if(argv[i].startsWith('--'))option(COMMAND_OPTIONS[args.command]);else positional.push(argv[i++]);}
  const cmd=args.command,needsId=['update','step','event','observe','check','result','complete','show',...SCHEDULER_IDS,...INTEGRATION_IDS,...CONVERSATION_IDS].includes(cmd);
  if(needsId){if(positional.length!==1)throw new TaskError(`${cmd} requires one ID`);args.id=positional[0];}
  else if(cmd==='render'){if(positional.length<1||positional.length>2||!['list','detail','bundle'].includes(positional[0]))throw new TaskError('render requires list, detail, or bundle');[args.view,args.id]=positional;}
  else if(positional.length)throw new TaskError(`unexpected argument: ${positional[0]}`);
  const defaults={init:{stale_hours:24,snapshot_note:''},register:{status:'queued',blocker:'',next_action:'',summary:'',source:''},event:{kind:'note',source:''},observe:{run_id:''},render:{language:'en',templates:DEFAULT_TEMPLATES}};
  for(const[k,v]of Object.entries(defaults[cmd]||{}))if(args[k]===undefined)args[k]=v;
  for(const k of ['lock_timeout','stale_hours'])if(args[k]!==undefined){if(typeof args[k]==='string'&&!args[k].trim())throw new TaskError(`${k} must be a number`);args[k]=Number(args[k]);}
  if(args.expected_revision!==undefined){if(!/^-?\d+$/.test(args.expected_revision))throw new TaskError('expected revision must be an integer');args.expected_revision=Number(args.expected_revision);if(!Number.isSafeInteger(args.expected_revision))throw new TaskError('expected revision must be a safe integer');}
  if(args.source_version!==undefined){if(!/^\d+$/.test(args.source_version))throw new TaskError('source version must be a positive integer');args.source_version=Number(args.source_version);if(!Number.isSafeInteger(args.source_version)||args.source_version<1)throw new TaskError('source version must be a positive safe integer');}
  const required={register:['title','goal'],event:['text'],observe:['state','source'],check:['name','outcome','evidence'],result:['label','url'],complete:['summary','evidence']};
  for(const k of required[cmd]||[])if(args[k]===undefined)throw new TaskError(`--${k.replaceAll('_','-')} is required`);
  const choices={};if(['register','update'].includes(cmd))choices.status=STATES.filter(s=>s!=='completed');if(cmd==='list')choices.status=STATES;if(cmd==='step')choices.state=STEP_STATES;if(cmd==='observe')choices.state=EXEC_STATES;if(cmd==='event')choices.kind=['note','progress','decision','blocker'];if(cmd==='check')choices.outcome=['pass','fail'];if(cmd==='render')choices.language=['en','zh'];
  for(const[k,values]of Object.entries(choices))if(args[k]!==undefined&&!values.includes(args[k]))throw new TaskError(`invalid ${k}: ${args[k]} (choose ${values.join(', ')})`);
  return args;
}
function initialization_result(store, initialized) {
  // This process has no platform memory capability and cannot attest persistence.
  // Do not cache a memory decision in the task store or infer it from init reuse.
  return { initialized, store:store.root, initialization_scope:'local_files_only', assistant_memory:{status:'not_checked',handled_by:'invoking_assistant',workflow:'references/first-use.md'} };
}
function recognized_lock_candidate(store, name) {
  if (!/^\.lock-candidate-[a-f0-9]{24}$/.test(name)) return false;
  try {
    const directory = store.path(name);
    const names = fs.readdirSync(directory);
    if (names.length !== 1 || !/^owner-\d+-[a-f0-9]{24}\.json$/.test(names[0])) return false;
    const owner = read_json(store.path(name + '/' + names[0]));
    return owner.schema_version === 1 && owner.token === names[0] && owner.hostname === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0;
  } catch (error) {
    // Another waiting command may have exited and removed its candidate.
    if (!fs.existsSync(store.path(name))) return true;
    return false;
  }
}
export function make_task(args) {const stamp=now();return {schema_version:VERSION,id:args.id?task_id(args.id):'task-'+uid(16),title:nonempty(args.title,'title'),goal:nonempty(args.goal,'goal'),status:args.status,created_at:stamp,updated_at:stamp,revision:1,work_revision:1,last_checked_at:null,blocker:args.blocker.trim(),next_action:args.next_action.trim(),summary:args.summary.trim(),steps:[],events:[event_record('registered','Task registered',args.source,stamp)],checks:[],results:[],execution:{state:'unknown',observed_at:null,source:'',run_id:''},completion:null};}

export async function run(args) {
  if(!Number.isFinite(args.lock_timeout)||args.lock_timeout<=0)throw new TaskError('lock timeout must be positive and finite');
  const store=new Store(args.store,args.lock_timeout),cmd=args.command;
  if(cmd==='start')await run({...args,command:'init',stale_hours:24,snapshot_note:''});
  const scheduler=create_scheduler({store,TaskError,encoded,read_json,nonempty,task_id,timestamp,timestamp_us,observed_time,newer_execution,now,event_record,display_time});
  const integration=createIntegration({store,scheduler,makeTask:make_task});
  if(has(CONVERSATION_OPTIONS,cmd))return createConversations({store}).run(args);
  if(has(INTEGRATION_OPTIONS,cmd))return integration.run(args);
  if(['wait','next-batch'].includes(cmd))return scheduler.wait(args);
  return store.locked(async()=>{
    if(cmd==='init'){
      if(!Number.isFinite(args.stale_hours)||args.stale_hours<=0)throw new TaskError('stale hours must be positive and finite');
      if(fs.existsSync(store.path('store.json'))){store.config();store.all();scheduler.inspect();readIntegration(store);readConversations(store);return initialization_result(store,false);}
      if(fs.readdirSync(store.root).some(n=>n!=='.lock'&&n!=='.lock-node'&&!recognized_lock_candidate(store,n)))throw new TaskError('directory is not an empty task store; choose another directory');
      store.commit({'store.json':encoded({schema_version:VERSION,created_at:now(),stale_hours:args.stale_hours,snapshot_note:args.snapshot_note}),'tasks.json':'[]\n'});
      return initialization_result(store,true);
    }
    const config=store.config();
    if(has(SCHEDULER_OPTIONS,cmd))return scheduler.execute(args);
    if(cmd==='register'){
      const make=()=>make_task(args);
      if(args.source_ref!==undefined)return scheduler.register(args,make);
      const t=make();store.save(t,true);return t;
    }
    if(cmd==='list')return store.selected({all:args.all,status:args.status}).map(index_row);
    if(cmd==='show')return store.get(args.id);
    if(['doctor','verify'].includes(cmd)){
      const tasks=store.all(),known=tasks.map(t=>t.id).sort(),directory=store.path('tasks'),found=fs.existsSync(directory)?fs.readdirSync(directory).sort():[];
      if(JSON.stringify(known)!==JSON.stringify(found))throw new TaskError('orphaned/missing task directories detected');
      for(const t of tasks){
        const actual={};
        for(const name of Object.keys(projections(t))){const p=store.path(`tasks/${t.id}/${name}`);if(!fs.existsSync(p))throw new TaskError(`derived file mismatch: ${t.id}/${name}`);actual[name]=fs.readFileSync(p,'utf8');}
        if(!['en','zh'].some(language=>Object.entries(projections(t,language)).every(([name,expected])=>actual[name]===expected)))throw new TaskError(`derived file mismatch: ${t.id}`);
      }
      scheduler.inspect();readIntegration(store);readConversations(store);
      return {ok:true,tasks:tasks.length,checked_at:now(),scope:'local integrity; this does not execute tests or verify external claims'};
    }
    if(cmd==='render'){
      let content,tasks;
      if(args.view==='detail'){if(!args.id)throw new TaskError('detail requires a task ID');content=render_task(decorateNotifications(store,scheduler.decorate([store.get(args.id)],args.language),args.language)[0],config,fs.readFileSync(path.join(args.templates,'task-detail.md'),'utf8'),new Date(),args.language);}
      else{if(args.id)throw new TaskError('only detail accepts a task ID');tasks=decorateNotifications(store,scheduler.decorate(store.selected({all:args.all}),args.language),args.language);content=render_list(tasks,config,fs.readFileSync(path.join(args.templates,'list.md'),'utf8'),args.view==='bundle',new Date(),args.all,args.language);}
      if(args.view!=='detail'){
        const failures=requestFailures(store),zh=args.language==='zh';
        if(failures.length)content+='\n## '+(zh?'未创建的请求':'Requests not created')+'\n\n'+failures.map(r=>'❌ '+(zh?'失败':'Failed')+' · '+(zh?'请求 ID: ':'Request ID: ')+r.id+' · '+uiTime(r.at)+'\n\n'+(r.stage==='parse'?(zh?'正文解析：':'Content parsing: '):(zh?'任务创建：':'Task creation: '))+safe_md(r.reason)).join('\n\n')+'\n';
      }
      if(args.view==='bundle'){
        if(!args.output)throw new TaskError('bundle requires --output DIRECTORY');
        const output=canonical_path(args.output);write_output(path.join(output,'index.md'),content,store);
        const template=fs.readFileSync(path.join(args.templates,'task-detail.md'),'utf8');for(const t of tasks)write_output(path.join(output,'tasks',`${t.id}.md`),render_task(t,config,template,new Date(),args.language),store);
        return {rendered:tasks.length+1,index:path.join(output,'index.md')};
      }
      if(args.output)return {rendered:1,path:write_output(args.output,content,store)};return content;
    }
    const fields=['title','goal','blocker','next_action','summary','status'];
    function change(t){
      if(cmd==='update'){
        if(fields.every(k=>args[k]==null))throw new TaskError('provide a field to update');const status=args.status||t.status;
        if(status!==t.status){if(!TRANSITIONS[t.status].includes(status))throw new TaskError(`transition ${t.status} → ${status} is not allowed`);nonempty(args.reason,'status-change reason');t.events.push(event_record('status',`${BADGES[t.status]} → ${BADGES[status]}: ${args.reason}`));}
        for(const k of fields)if(args[k]!=null)t[k]=['title','goal'].includes(k)?nonempty(args[k],k):args[k].trim();
      }else if(cmd==='step'){
        let step;if(args.step_id){step=t.steps.find(s=>s.id===args.step_id);if(!step)throw new TaskError('unknown step ID');if(args.title==null&&args.state==null&&args.evidence==null)throw new TaskError('provide a step field to update');if(args.title!=null)step.title=nonempty(args.title,'step title');if(args.state!=null)step.state=args.state;if(args.evidence!=null)step.evidence=args.evidence.trim();}
        else{step={id:'step-'+uid(12),title:nonempty(args.title,'step title'),state:args.state||'queued',evidence:args.evidence||''};t.steps.push(step);}t.events.push(event_record('step',`Step: ${step.title} (${step.state})`));
      }else if(cmd==='event'){t.events.push(event_record(args.kind,args.text,args.source));}
      else if(cmd==='observe'){
        const at=observed_time(args.observed_at),next={state:args.state,observed_at:at,source:nonempty(args.source,'source'),run_id:args.run_id,...(args.source_version===undefined?{}:{source_version:args.source_version})};if(!newer_execution(t.execution,next))throw new TaskError('older observation or source version rejected; do not regress the latest execution snapshot');t.execution=next;if(!t.last_checked_at||timestamp_us(at)>timestamp_us(t.last_checked_at))t.last_checked_at=at;t.events.push(event_record('observation',`Execution observation: ${EXEC_LABELS[args.state]}`,args.source,at));
      }else if(cmd==='check'){
        if(t.status==='completed')throw new TaskError('reopen before recording a new acceptance check');const at=observed_time(args.checked_at);if(timestamp_us(at)<timestamp_us(t.updated_at))throw new TaskError('check predates latest update; record a current check or an ordinary historical event');t.checks.push({id:'check-'+uid(12),name:nonempty(args.name,'check name'),outcome:args.outcome,evidence:nonempty(args.evidence,'check evidence'),at,work_revision:t.work_revision});t.last_checked_at=at;t.events.push(event_record('check',`Verification ${args.name}: ${args.outcome}`,'',at));
      }else if(cmd==='result'){
        const url=safe_link(args.url);if(t.results.some(r=>r.url===url))throw new TaskError('result URL already recorded');t.results.push({id:'result-'+uid(12),label:nonempty(args.label,'result label'),url});t.events.push(event_record('result',`Result link recorded: ${args.label}`));
      }else if(cmd==='complete'){
        if(t.status!=='awaiting_verification')throw new TaskError('completion requires awaiting_verification status');const checks=current_checks(t);if(!checks.length||checks.some(c=>c.outcome!=='pass'))throw new TaskError('completion requires current passing checks and no current failing checks');if(t.blocker||t.steps.some(s=>!['completed','skipped'].includes(s.state)))throw new TaskError('resolve blockers and unfinished steps before completion');const stamp=now();t.status='completed';t.next_action='';t.completion={at:stamp,summary:nonempty(args.summary,'summary'),evidence:nonempty(args.evidence,'evidence'),work_revision:t.work_revision};t.events.push(event_record('completed',args.summary,'',stamp));
      }else throw new TaskError('unknown command');
    }
    let work=['update','step','result'].includes(cmd);
    if(cmd==='update'&&args.summary!=null&&['title','goal','blocker','next_action','status'].every(k=>args[k]==null))work=false;
    if(cmd==='update'&&args.status==='executing'&&store.get(args.id).status==='completed')return store.mutate(args.id,args.expected_revision,t=>{change(t);t.work_revision++;t.completion=null;},false);
    return store.mutate(args.id,args.expected_revision,change,work);
  },cmd==='init');
}
export async function main(argv=process.argv.slice(2)) {
  try{require_node();const args=parse_args(argv);if(args.help){process.stdout.write(args.help);return 0;}const result=await run(args);process.stdout.write(typeof result==='string'?result+(result.endsWith('\n')?'':'\n'):encoded(result));return 0;}
  catch(e){process.stderr.write(`taskctl: ${e.message}\n`);return 2;}
}
if(is_main(import.meta.url))process.exitCode=await main();
