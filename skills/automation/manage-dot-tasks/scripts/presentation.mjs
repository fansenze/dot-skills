/** User-facing labels are independent of the durable acceptance state machine. */
const labels = {
  zh: {queued:'🕒 排队中',executing:'🚧 执行中',awaiting_verification:'🚧 执行中',blocked:'🕒 排队中',failed:'❌ 失败',completed:'✅ 成功',cancelled:'❌ 失败'},
  en: {queued:'🕒 Pending',executing:'🚧 In progress',awaiting_verification:'🚧 In progress',blocked:'🕒 Pending',failed:'❌ Failed',completed:'✅ Succeeded',cancelled:'❌ Failed'}
};
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
