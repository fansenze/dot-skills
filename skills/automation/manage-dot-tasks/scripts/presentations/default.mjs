/** Default text/Markdown presentation. Provider components do not belong here. */
const escape = value => String(value).replaceAll('<','‹').replaceAll('>','›').replace(/([\\`*_{}\[\]()#!|~])/g,'\\$1');
import {validateResponse, responseTitles as defaults} from './schema.mjs';
const clock = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const groupStatus = item => item.status?.match(/^(?:[🕒🚧❌✅] )?(排队中|执行中|受阻|待确认|待验收|已完成|已取消|成功|失败|Pending|In progress|Blocked|Awaiting verification|Completed|Cancelled|Succeeded|Failed)(?: ·.*)?$/u)?.[1] ?? item.status ?? '未标注状态';
function blocks(r) {
  const out = [];
  if (r.status) out.push({kind:'status',text:r.status});
  if (r.list_scope) out.push({kind:'scope',text:{recent_active:'最近更新 · 最多 10 个活跃任务',history:'按请求查询 · 历史任务',selected:'按请求查询 · 指定范围'}[r.list_scope]});
  out.push({kind:'lead',text:r.lead});
  const addItem = (item, grouped = false) => {
    // A group already names the status. Keep a status suffix (e.g. completion time).
    const duplicate = grouped && item.status?.replace(/^[🕒🚧❌✅] /u,'') === groupStatus(item);
    out.push({kind:'item',title:item.title,text:[!duplicate && item.status,item.summary,item.blocker && '受阻：'+item.blocker,item.next_action && '下一步：'+item.next_action].filter(Boolean).join('\n')});
    if (item.url) out.push({kind:'link',link:{label:item.title,url:item.url}});
  };
  if (r.template === 'list') {
    const groups = new Map();
    for (const item of r.items) {
      const status = groupStatus(item);
      if (!groups.has(status)) groups.set(status, []);
      groups.get(status).push(item);
    }
    for (const [status, items] of groups) {
      out.push({kind:'group',title:`${status} · ${items.length} 项（本页）`});
      items.forEach(item => addItem(item, true));
    }
  } else (r.items ?? []).forEach(item => addItem(item));
  for (const s of r.sections ?? []) if (s.items.length) out.push({kind:'section',title:s.title,text:s.items.map(x => '• '+x).join('\n')});
  for (const [i,o] of (r.options ?? []).entries()) out.push({kind:'option',title:`${String(i+1).padStart(2,'0')}. ${o.label}`,text:o.description});
  for (const link of r.links ?? []) out.push({kind:'link',link});
  if (r.coverage) {
    const {shown,total} = r.coverage;
    const coverage = total === null ? `本次展示 ${shown} 个${r.list_scope === 'recent_active' ? '活跃任务' : '任务'} · 总数未知` :
      shown < total ? `仅显示 ${shown}/${total} 项，列表未完整展示。` : `共 ${total} 项，已完整展示。`;
    out.push({kind:'footer',text:coverage});
  }
  if (r.data_time) out.push({kind:'footer',text:(r.time_label ?? (r.template === 'brief' ? '截至' : '数据时间'))+'：'+clock.format(new Date(r.data_time))+' · Asia/Shanghai'});
  if (r.source) out.push({kind:'footer',text:'来源：'+r.source});
  return out;
}
export function renderDefaultResponse(r, format = 'markdown') {
  const title = r.title ?? defaults[r.template], parts = blocks(r);
  // Feishu text also recognizes mention tags: escape markup even without Markdown.
  const safe = format === 'markdown' ? escape : value => String(value).replaceAll('<','‹').replaceAll('>','›');
  const lines = parts.map(b => [b.title && (format === 'markdown' ? (b.kind === 'group' ? '---\n\n## '+safe(b.title) : '**'+safe(b.title)+'**') : safe(b.title)),b.text && (format === 'markdown' && b.kind === 'footer' ? '*'+safe(b.text)+'*' : safe(b.text)),b.link && (format === 'markdown' ? `[${safe(b.link.label)}](${b.link.url.replace(/[()\\]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())})` : `${safe(b.link.label)}: ${safe(b.link.url)}`)].filter(Boolean).join('\n'));
  return [...(r.template === 'ack' ? [] : [format === 'markdown' ? '# '+safe(title) : safe(title)]),...lines].join('\n\n');
}

export function renderDefaultDocument(doc, format = 'markdown') {
  if (!['text','markdown'].includes(format)) throw new Error('Unsupported default presentation format');
  return renderDefaultResponse(validateResponse(doc.response),format);
}

export const defaultReceipt = context => context.conversation.matches.length ? null : {operation:'message'};
