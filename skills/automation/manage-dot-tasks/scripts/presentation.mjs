import {validateResponse,renderResponse} from './reply-presentation.mjs';
import {selectTaskList} from './task-list.mjs';
/** User-facing labels are independent of the durable acceptance state machine. */
const labels = {
  zh: {queued:'🕒 排队中',executing:'🚧 执行中',awaiting_verification:'🚧 执行中',blocked:'🕒 排队中',failed:'❌ 失败',completed:'✅ 成功',cancelled:'❌ 失败'},
  en: {queued:'🕒 Pending',executing:'🚧 In progress',awaiting_verification:'🚧 In progress',blocked:'🕒 Pending',failed:'❌ Failed',completed:'✅ Succeeded',cancelled:'❌ Failed'}
};
const taskLabels = {
  zh:{queued:'排队中',executing:'执行中',blocked:'受阻',awaiting_verification:'待验收',completed:'已完成',failed:'失败',cancelled:'已取消'},
  en:{queued:'Pending',executing:'In progress',blocked:'Blocked',awaiting_verification:'Awaiting verification',completed:'Completed',failed:'Failed',cancelled:'Cancelled'}
};
export const taskStatusLabel = (task, language = 'zh') => taskLabels[language][task.status];
const clock = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export const uiTime = value => clock.format(new Date(value));
export const userStatus = (task, language = 'zh') => labels[language][task.status] +
  (task.status === 'completed' ? ' · '+uiTime(task.completion.at) : '');
export function taskDocument(tasks, language = 'zh', detail = tasks.length === 1) {
  const zh = language === 'zh';
  const checks = t => [...new Map(t.checks.filter(c=>c.work_revision===t.work_revision).map(c=>[c.name,c])).values()];
  const outcomeReason = t => {
    if (!['failed','cancelled'].includes(t.status)) return '';
    const event = t.events.filter(e=>e.kind==='status').at(-1)?.text ?? '';
    const separator = /[:：]/.exec(event);
    return separator ? event.slice(separator.index+1).trimStart() : '';
  };
  const summary = t => [...new Set([t.status === 'completed' ? t.completion.summary :
    (t.summary || outcomeReason(t) || t.events.filter(e=>['progress','decision','blocker'].includes(e.kind)).at(-1)?.text || t.next_action),
    outcomeReason(t),
    t.blocker ? (zh?'受阻，等待处理：':'Blocked, waiting for action: ')+t.blocker : '', t.status === 'cancelled' ? (zh?'已取消，未完成':'Cancelled; not completed') : '', ...checks(t).filter(c=>c.outcome==='fail').map(c=>(zh?'验证未通过：':'Check failed: ')+c.name)].filter(Boolean))].join('; ');
  if (detail && tasks.length === 1) {
    const t = tasks[0], brief = summary(t);
    return {title:t.title,updated_at:t.updated_at,columns:[],rows:[],details:[
      'ID: '+t.id, userStatus(t,language), ...(brief && brief!==t.title ? [brief] : []),
      ...(t.goal && ![t.title,brief].includes(t.goal) ? [(zh?'目标：':'Goal: ')+t.goal] : []),
      ...(!['completed','cancelled'].includes(t.status) && t.next_action && ![t.title,brief,t.goal].includes(t.next_action) ? [(zh?'下一步：':'Next: ')+t.next_action] : []),
      ...checks(t).map(c=>`${c.outcome==='pass'?'✅':'❌'} ${c.name} · ${c.evidence}`),
      ...t.results.map(r=>`${r.label}: ${r.url}`)]};
  }
  return {title:zh?'任务列表':'Tasks',updated_at:new Date().toISOString(),columns:zh?['标题','状态','信息描述']:['Title','Status','Summary'],
    rows:tasks.map(t=>[t.title,userStatus(t,language),summary(t)]),details:[]};
}

/** Structured transport projection; retain legacy columns/details for old adapters. */
export function taskResponseDocument(tasks, language = 'zh', detail = tasks.length === 1) {
  if (!detail) tasks = selectTaskList(tasks);
  const doc = taskDocument(tasks, language, detail), zh = language === 'zh';
  const states = taskLabels[language];
  const clip = (value, max = 1000) => { const s=String(value).toWellFormed().replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')); return s.length <= max ? String(s) : String(s).slice(0,max-35).toWellFormed()+(zh?'…（内容过长，未完整展示，请查看任务详情）':'… (partial; inspect task details)'); };
  if (detail && tasks.length === 1) {
    const t = tasks[0];
    const current = [...new Map(t.checks.filter(c=>c.work_revision===t.work_revision).map(c=>[c.name,c])).values()];
    const failed = current.filter(c=>c.outcome==='fail');
    const sections = [];
    if (t.goal && t.goal !== t.title && t.goal !== t.summary) sections.push({title:zh?'任务目标':'Goal',items:[clip(t.goal,500)]});
    if (t.blocker) sections.push({title:zh?'受阻':'Blocked',items:[clip(t.blocker)]});
    if (failed.length) sections.push({title:zh?'验证未通过':'Failed checks',items:failed.slice(0,3).map(c=>clip(c.name+' · '+c.evidence,250)).concat(failed.length>3 ? [zh?'更多失败检查未展示，请查看任务详情。':'More failed checks omitted; inspect task details.'] : [])});
    if (!failed.length && current.length) sections.push({title:zh?'验收检查':'Acceptance checks',items:current.slice(0,3).map(c=>clip('✓ '+c.name+' · '+c.evidence,250)).concat(current.length>3 ? [zh?'更多检查未展示，请查看任务详情。':'More checks omitted; inspect task details.'] : [])});
    if (t.steps.length) sections.push({title:zh?'执行步骤':'Steps',items:t.steps.slice(0,6).map(s=>clip(({completed:'✓',executing:'◉',queued:'○',skipped:'−'}[s.state] ?? '○')+' '+s.title+(s.state==='skipped' ? ' · '+(zh?'已跳过':'Skipped')+(s.evidence ? ' · '+s.evidence : '') : ''),200)).concat(t.steps.length>6 ? [zh?'更多步骤未展示，请查看任务详情。':'More steps omitted; inspect task details.'] : [])});
    const reason = ['failed','cancelled'].includes(t.status) ? t.events.filter(e=>e.kind==='status').at(-1)?.text.replace(/^[^:：]*[:：]\s*/,'') : '';
    if (reason && reason !== t.summary) sections.push({title:zh?'原因':'Reason',items:[clip(reason,500)]});
    if (t.next_action && !['completed','cancelled'].includes(t.status)) sections.push({title:zh?'下一步':'Next',items:[clip(t.next_action,500)]});
    let links = t.results.slice(0,10).flatMap(r=>{const link={label:clip(r.label,160),url:r.url};try {validateResponse({template:'detail',lead:'Result',links:[link]}); return [link];} catch {return [];}});
    while (Buffer.byteLength(JSON.stringify({sections,links})) > 17000 && links.length) links.pop();
    for (;;) {
      const omitted = t.results.length-links.length;
      const coverage = omitted ? [{title:zh?'结果覆盖':'Result coverage',items:[zh?`${omitted} 个结果链接未展示，请查看任务详情。`:`${omitted} result links omitted; inspect task details.`]}] : [];
      doc.response = validateResponse({template:'detail',title:clip(t.title.replace(/[\r\n\t]/g,' '),160),lead:clip(t.status==='completed'?t.completion.summary:(t.summary || reason || t.next_action || states[t.status]),1000),status:states[t.status],data_time:t.status==='completed'?t.completion.at:t.updated_at,time_label:t.status==='completed'?(zh?'完成于':'Completed'):(zh?'更新于':'Updated'),links,sections:[...sections,...coverage]});
      if (['text','markdown','card'].every(f=>Buffer.byteLength(JSON.stringify(renderResponse(doc.response,f)))<=28000)) break;
      if(!links.length) throw new Error('Task response exceeds presentation bounds');
      links.pop();
    }
  } else {
    let items = doc.rows.map(([title,,summary],index)=>({title:clip(title,160),status:states[tasks[index].status],...(summary ? {summary:clip(summary)} : {})}));
    for (;;) {
      const omitted = tasks.length-items.length;
      const limitNote = omitted ? (zh?`另有 ${omitted} 项因消息长度限制未展示，请查询详情。`:`${omitted} fetched tasks omitted for message length; query their details.`) : '';
      try { doc.response = validateResponse({template:'list',title:zh?'活跃任务':'Active tasks',lead:(tasks.length?(zh?'以下是本次查到的近期活跃任务。':'Recently updated active tasks from this query.'):(zh?'本次未查到活跃任务。':'No active tasks found in this query.'))+(limitNote?'\n'+limitNote:''),list_scope:'recent_active',items,coverage:{shown:items.length,total:null},data_time:doc.updated_at,time_label:zh?'核对于':'Checked'}); if(['text','markdown','card'].some(f=>Buffer.byteLength(JSON.stringify(renderResponse(doc.response,f)))>28000)) throw new Error('render bounds'); break; }
      catch (error) { if(!items.length) throw error; items=items.slice(0,-1); }
    }
  }
  return doc;
}
