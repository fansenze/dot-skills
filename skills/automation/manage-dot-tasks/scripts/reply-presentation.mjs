/** Plain-content response schema. No raw provider markup or executable actions. */
const fail = message => { throw new Error(`Invalid response: ${message}`); };
const object = (v, fields, name) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) fail(name);
};
const text = (v, name, max = 1000) => {
  if (typeof v !== 'string' || !v.isWellFormed() || !v.trim() || v.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(v)) fail(name);
};
const url = v => {
  text(v, 'URL', 2048);
  let u; try { u = new URL(v); } catch { fail('URL'); }
  if (!/^https?:\/\//i.test(v) || v.includes('\\') || !['https:', 'http:'].includes(u.protocol) || u.username || u.password || /[\s<>]/u.test(v)) fail('URL');
};
const array = (v, max, name, each) => {
  if (!Array.isArray(v) || v.length > max) fail(name);
  v.forEach(each);
};
export function validateResponse(value) {
  object(value, ['template','title','lead','status','items','sections','links','options','data_time','time_label','list_scope','source','coverage','format_override'], 'fields');
  const r = value;
  if (!['ack','list','detail','decision','brief'].includes(r.template)) fail('template');
  text(r.lead, 'lead', r.template === 'ack' ? 300 : 4000);
  if (r.title !== undefined) { text(r.title, 'title', 160); if (/[\r\n\t]/.test(r.title)) fail('title'); }
  for (const key of ['status','time_label']) if (r[key] !== undefined) { text(r[key], key, 80); if (/[\r\n\t]/.test(r[key])) fail(key); }
  if (r.time_label !== undefined && !r.data_time) fail('time label requires data time');
  if (r.list_scope !== undefined && (r.template !== 'list' || !['recent_active','history','selected'].includes(r.list_scope))) fail('list scope');
  if (r.items !== undefined) array(r.items, 20, 'items', item => {
    object(item, ['title','status','summary','blocker','next_action','url'], 'item'); text(item.title, 'item title', 160);
    for (const key of ['status','summary','blocker','next_action']) if (item[key] !== undefined) text(item[key], key);
    if (item.url !== undefined) url(item.url);
  });
  if (r.sections !== undefined) array(r.sections, 8, 'sections', s => {
    object(s, ['title','items'], 'section'); text(s.title, 'section title', 160); array(s.items, 20, 'section items', x => text(x, 'section item'));
  });
  if (r.links !== undefined) array(r.links, 10, 'links', l => { object(l,['label','url'],'link'); text(l.label,'link label',160); url(l.url); });
  if (r.options !== undefined) array(r.options, 10, 'options', o => {
    object(o,['label','description'],'option'); text(o.label,'option label',160); text(o.description,'option description');
  });
  if (r.coverage !== undefined) {
    object(r.coverage,['shown','total'],'coverage');
    if (!Number.isSafeInteger(r.coverage.shown) || r.coverage.shown !== (r.items?.length ?? 0) || (r.coverage.total !== null && (!Number.isSafeInteger(r.coverage.total) || r.coverage.total < r.coverage.shown))) fail('coverage');
  }
  if (r.template === 'list' && (!r.items || !r.coverage)) fail('list requires items and coverage');
  if (r.list_scope === 'recent_active' && r.items.length > 10) fail('recent active lists contain at most 10 items');
  if (r.template === 'decision' && !r.options?.length) fail('decision requires options');
  if (r.template === 'ack' && (/[\r\n\t]/.test(r.lead) || ['items','sections','links','options','coverage','data_time','time_label','list_scope','status','source','title'].some(k => r[k] !== undefined))) fail('ack must be one short sentence');
  if (r.data_time !== undefined && (typeof r.data_time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(r.data_time) || !Number.isFinite(Date.parse(r.data_time)))) fail('data time');
  if (r.data_time !== undefined) { const day=r.data_time.slice(0,10); if (new Date(day+'T00:00:00Z').toISOString().slice(0,10) !== day || Number(r.data_time.slice(11,13))>23 || Number(r.data_time.slice(14,16))>59 || Number(r.data_time.slice(17,19))>59) fail('data time'); }
  if (r.source !== undefined) text(r.source,'source');
  if (r.template === 'brief' && (!r.data_time || !r.source)) fail('brief requires data time and source');
  if (r.format_override !== undefined) {
    object(r.format_override,['format','authorization_ref'],'format override');
    if (!['text','markdown','card'].includes(r.format_override.format)) fail('format override');
    text(r.format_override.authorization_ref,'format authorization',256);
    if (/[\r\n\t]/.test(r.format_override.authorization_ref)) fail('format authorization');
  }
  if (Buffer.byteLength(JSON.stringify(r)) > 24576) fail('content exceeds 24 KiB; provide an explicitly partial page with coverage');
  return structuredClone(r);
}
const escape = value => String(value).replaceAll('<','‹').replaceAll('>','›').replace(/([\\`*_{}\[\]()#!|~])/g,'\\$1');
const defaults = {ack:'收到',list:'任务列表',detail:'任务详情',decision:'需要你确认',brief:'定时简报'};
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
export function renderResponse(value, format = 'markdown') {
  const r = validateResponse(value), title = r.title ?? defaults[r.template], parts = blocks(r);
  if (!['text','markdown','card'].includes(format)) fail('render format');
  if (format === 'card') {
    // All authored content stays in native plain-text nodes, including headings.
    const plain = (content, text_size = 'normal') => ({tag:'div',text:{tag:'plain_text',content,text_size}});
    const note = content => ({tag:'note',elements:[{tag:'plain_text',content}]});
    const column = (elements, margin, padding = '0px', background_style = 'default') => ({tag:'column_set',flex_mode:'none',background_style,margin,columns:[{tag:'column',width:'weighted',weight:1,padding,vertical_spacing:'4px',elements}]});
    const elements = [];
    let groups = 0, footer = false;
    for (const b of parts) {
      if (b.kind === 'group') {
        if (groups++) elements.push({tag:'hr'});
        elements.push(column([plain(b.title)],'24px 0px 12px 0px','8px 10px 8px 10px','grey'));
      } else if (b.kind === 'footer') {
        if (!footer) { elements.push({tag:'hr'}); footer = true; }
        elements.push(note(b.text));
      } else if (b.link) {
        elements.push({tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:b.link.label},type:'default',url:b.link.url}]});
      } else if (b.kind === 'scope' || b.kind === 'status') elements.push(note(b.text));
      else {
        if (b.title) elements.push(column([plain(b.title,'heading'),...(b.text ? [plain(b.text)] : [])],b.kind==='item'?'8px 0px 8px 0px':'16px 0px 8px 0px',b.kind==='item'?'0px 10px 0px 10px':'0px'));
        else if (b.text) elements.push(plain(b.text));
      }
    }
    return {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:title}},elements};
  }
  // Feishu text also recognizes mention tags: escape markup even without Markdown.
  const safe = format === 'markdown' ? escape : value => String(value).replaceAll('<','‹').replaceAll('>','›');
  const lines = parts.map(b => [b.title && (format === 'markdown' ? (b.kind === 'group' ? '---\n\n## '+safe(b.title) : '**'+safe(b.title)+'**') : safe(b.title)),b.text && (format === 'markdown' && b.kind === 'footer' ? '*'+safe(b.text)+'*' : safe(b.text)),b.link && (format === 'markdown' ? `[${safe(b.link.label)}](${b.link.url.replace(/[()\\]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())})` : `${safe(b.link.label)}: ${safe(b.link.url)}`)].filter(Boolean).join('\n'));
  return [...(r.template === 'ack' ? [] : [format === 'markdown' ? '# '+safe(title) : safe(title)]),...lines].join('\n\n');
}
export function responseDocument(value, updatedAt = new Date().toISOString()) {
  const response = validateResponse(value);
  return {title:response.title ?? defaults[response.template],updated_at:updatedAt,columns:[],rows:[],details:[renderResponse(response,'text')],response};
}
export function responseFormat(doc, fallback, caps) {
  if (!doc.response) return fallback;
  const response = validateResponse(doc.response), formats = caps.formats;
  const chosen = response.format_override?.format ?? (response.template === 'ack' && formats.includes('text') ? 'text' : fallback);
  if (!formats.includes(chosen)) fail('requested format is unsupported by this connector');
  return chosen;
}
