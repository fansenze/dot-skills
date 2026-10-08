/** Feishu presentation and receipt policy; no network, credentials or task mutations. */
import {validateResponse, responseTitles as titles} from './schema.mjs';
import {renderDefaultDocument} from './default.mjs';

const clock = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
const statusLabel = status => status?.match(/^(?:[🕒🚧❌✅] )?(排队中|执行中|受阻|待确认|待验收|已完成|已取消|成功|失败|Pending|In progress|Blocked|Awaiting verification|Completed|Cancelled|Succeeded|Failed)(?: ·.*)?$/u)?.[1] ?? status ?? '未标注状态';
const statusColor = status => ({已完成:'green',成功:'green',Completed:'green',Succeeded:'green',执行中:'blue','In progress':'blue',待验收:'blue','Awaiting verification':'blue',受阻:'orange',待确认:'orange',Blocked:'orange',失败:'red',Failed:'red'})[statusLabel(status)] ?? 'neutral';
const plain = (content, size = 'normal', color = 'default') => ({tag:'div',text:{tag:'plain_text',content,text_size:size,text_color:color}});
const column = (elements, margin = '0px', background = 'default', padding = '0px') => ({tag:'column_set',flex_mode:'none',background_style:background,margin,
  columns:[{tag:'column',width:'weighted',weight:1,padding,vertical_spacing:'4px',elements}]});
const label = content => plain(content,'notation','grey');
// Only reviewed links enter Markdown; authored prose remains plain text.
const linkText = link => ({tag:'div',text:{tag:'lark_md',content:`[${link.label.replace(/[\r\n\t]/g,' ').replaceAll('<','‹').replaceAll('>','›').replace(/([\\`*_{}\[\]()#!|~])/g,'\\$1')}](${link.url.replace(/[()\\`\[\]"]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())})`}});

export function renderFeishuResponse(value) {
  const r = validateResponse(value), elements = [];
  // Supported native header tags keep status with the title, without an extra row.
  const heading = r.title ?? (r.template === 'list' ? titles.list : undefined);
  const header = heading ? {title:{tag:'plain_text',content:heading},template:'default',
    ...(r.status ? {text_tag_list:[{tag:'text_tag',text:{tag:'plain_text',content:r.status},color:statusColor(r.status)}]} : {})} : undefined;
  elements.push(plain(r.lead));
  if (!header && r.status) elements.push(label(r.status));
  if (r.list_scope) elements.push(label({recent_active:'最近更新的活跃任务 · 最多 10 个',history:'历史任务',selected:'指定范围内的任务'}[r.list_scope]));
  const item = (row, grouped = false) => {
    const duplicate = grouped && row.status && row.status.replace(/^[🕒🚧❌✅] /u,'') === statusLabel(row.status);
    const status = row.status && !duplicate ? row.status : null;
    const info = [status,row.summary,row.blocker && '受阻：'+row.blocker,row.next_action && '下一步：'+row.next_action].filter(Boolean);
    elements.push(column([plain(row.title,'heading'),...info.map(text=>plain(text))],'8px 0px 8px 0px','default','0px 8px 0px 8px'));
    if (row.url) elements.push(linkText({label:row.title,url:row.url}));
  };
  if (r.template === 'list') {
    const groups = new Map();
    for (const row of r.items) { const status = statusLabel(row.status); if (!groups.has(status)) groups.set(status,[]); groups.get(status).push(row); }
    let index = 0;
    for (const [status, rows] of groups) {
      if (index++) elements.push({tag:'hr'});
      elements.push(column([plain(`${status} · ${rows.length} 项（本页）`)],'24px 0px 12px 0px','grey','8px 10px 8px 10px'));
      rows.forEach(row=>item(row,true));
    }
  } else (r.items ?? []).forEach(row=>item(row));
  for (const section of r.sections ?? []) if (section.items.length) {
    const rows = section.items.map(text => plain(section.items.length === 1 || /^(?:[✓◉○−•]|\d+[.)])\s/u.test(text) ? text : '• '+text));
    elements.push(column([label(section.title),...rows],'8px 0px 0px 0px'));
  }
  for (const [index, option] of (r.options ?? []).entries()) elements.push(column([plain(`${String(index+1).padStart(2,'0')}. ${option.label}`),plain(option.description)],'8px 0px 0px 0px'));
  for (const link of r.links ?? []) elements.push(linkText(link));
  const footer = [];
  if (r.coverage) {
    const {shown,total} = r.coverage;
    footer.push(total === null ? `本次展示 ${shown} 个${r.list_scope === 'recent_active' ? '活跃任务' : '任务'} · 总数未知` : shown < total ? `仅显示 ${shown}/${total} 项，列表未完整展示。` : `共 ${total} 项，已完整展示。`);
  }
  if (r.data_time) footer.push(`${r.time_label ?? (r.template === 'brief' ? '截至' : '数据时间')}：${clock.format(new Date(r.data_time))} · 北京时间`);
  if (r.source) footer.push('来源：'+r.source);
  if (footer.length) elements.push({tag:'hr'},column(footer.map(label)));
  return {config:{wide_screen_mode:true},...(header ? {header} : {}),elements};
}

export function renderFeishuDocument(doc, format = 'card') {
  return format === 'card' ? renderFeishuResponse(doc.response) : renderDefaultDocument(doc,format);
}
/** Provider references establish a topic, never a task association or authority. */
export function feishuReceipt({entry, history, notices, conversation}) {
  const e = entry.envelope;
  const previous = history.filter(p=>p.id !== entry.id && p.mode === 'agent' && p.grant_id === entry.grant_id && p.binding === entry.binding && p.connector === entry.connector &&
    ['account_id','tenant_id','destination_id'].every(k=>p.envelope?.[k] === e[k]));
  const roots = new Map();
  const root = id => {
    if (!roots.has(id)) roots.set(id,id);
    let current = id;
    while (roots.get(current) !== current) current = roots.get(current);
    while (roots.get(id) !== id) { const next=roots.get(id); roots.set(id,current); id=next; }
    return current;
  };
  const join = ids => {
    const values = ids.filter(Boolean);
    if (values.length) for (const id of values.slice(1)) roots.set(root(id),root(values[0]));
  };
  const references = envelope => ['message_id','root_id','thread_id','parent_id'].map(k=>envelope[k]);
  for (const p of [...previous,entry]) join(references(p.envelope));
  const ids = new Set(previous.map(p=>p.envelope.message_id));
  for (const n of notices) if (n.route.binding===entry.binding && n.route.policy_id===entry.grant_id && n.route.account_id===e.account_id && n.route.destination.id===e.destination_id && ids.has(n.reply_to) && n.receipt?.status==='api_accepted' && n.receipt.message_id && n.operation!=='react') join([n.reply_to,...references(n.receipt)]);
  // Canonical conversation matches have already passed their original-root checks.
  for (const match of conversation.matches) join([e.message_id,match.root_id]);
  return previous.some(p=>root(p.envelope.message_id)===root(e.message_id))
    ? {operation:'react',reaction:{message_id:e.message_id,emoji_type:'Get'}} : {operation:'message'};
}

export function validFeishuReceipt(notice, incoming) {
  return incoming?.envelope && notice.reaction?.message_id===incoming.envelope.message_id && notice.reaction?.emoji_type==='Get' && Object.keys(notice.reaction).length===2;
}
