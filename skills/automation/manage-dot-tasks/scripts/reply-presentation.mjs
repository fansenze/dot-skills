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
  object(value, ['template','title','lead','items','sections','links','options','data_time','source','coverage','format_override'], 'fields');
  const r = value;
  if (!['ack','list','detail','decision','brief'].includes(r.template)) fail('template');
  text(r.lead, 'lead', r.template === 'ack' ? 300 : 4000);
  if (r.title !== undefined) { text(r.title, 'title', 160); if (/[\r\n\t]/.test(r.title)) fail('title'); }
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
    if (!Number.isSafeInteger(r.coverage.shown) || !Number.isSafeInteger(r.coverage.total) || r.coverage.shown !== (r.items?.length ?? 0) || r.coverage.total < r.coverage.shown) fail('coverage');
  }
  if (r.template === 'list' && (!r.items || !r.coverage)) fail('list requires items and coverage');
  if (r.template === 'decision' && !r.options?.length) fail('decision requires options');
  if (r.template === 'ack' && (/[\r\n\t]/.test(r.lead) || ['items','sections','links','options','coverage','data_time','source','title'].some(k => r[k] !== undefined))) fail('ack must be one short sentence');
  if (r.data_time !== undefined && (typeof r.data_time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?(?:Z|[+-]\d\d:\d\d)$/.test(r.data_time) || !Number.isFinite(Date.parse(r.data_time)))) fail('data time');
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
function blocks(r) {
  const out = [{text:r.lead}];
  if(r.template === 'detail') for (const link of r.links ?? []) out.push({link});
  const addItem = item => out.push({text:[item.title,item.status,item.summary,item.blocker && '受阻：'+item.blocker,item.next_action && '下一步：'+item.next_action].filter(Boolean).join('\n'), ...(item.url ? {link:{label:item.title,url:item.url}} : {})});
  if (r.template === 'list') {
    const groups = new Map();
    for (const item of r.items) {
      const status = item.status?.match(/^(?:[🕒🚧❌✅] )?(排队中|执行中|成功|失败|Pending|In progress|Succeeded|Failed)(?: ·.*)?$/u)?.[1] ?? item.status ?? '未标注状态';
      if (!groups.has(status)) groups.set(status, []);
      groups.get(status).push(item);
    }
    for (const [status, items] of groups) {
      out.push({text:`${status} · ${items.length} 项（本页）`});
      items.forEach(addItem);
    }
  } else (r.items ?? []).forEach(addItem);
  for (const s of r.sections ?? []) out.push({text:s.title+'\n'+s.items.map(x => '• '+x).join('\n')});
  for (const [i,o] of (r.options ?? []).entries()) out.push({text:`${i+1}. ${o.label}\n${o.description}`});
  if(r.template !== 'detail') for (const link of r.links ?? []) out.push({link});
  if (r.coverage) out.push({text:r.coverage.shown < r.coverage.total ? `仅显示 ${r.coverage.shown}/${r.coverage.total} 项，列表未完整展示。` : `共 ${r.coverage.total} 项，已完整展示。`});
  if (r.data_time) out.push({text:'数据时间：'+r.data_time});
  if (r.source) out.push({text:'来源：'+r.source});
  return out;
}
export function renderResponse(value, format) {
  const r = validateResponse(value), title = r.title ?? defaults[r.template], parts = blocks(r);
  if (!['text','markdown','card'].includes(format)) fail('render format');
  if (format === 'card') {
    const plain = content => ({tag:'div',text:{tag:'plain_text',content}});
    return {config:{wide_screen_mode:true},header:{title:{tag:'plain_text',content:title}},elements:parts.flatMap(b => [
      ...(b.text ? [plain(b.text)] : []), ...(b.link ? [{tag:'action',actions:[{tag:'button',text:{tag:'plain_text',content:b.link.label},type:'default',url:b.link.url}]}] : [])])};
  }
  // Feishu text also recognizes mention tags: escape markup even without Markdown.
  const safe = format === 'markdown' ? escape : value => String(value).replaceAll('<','‹').replaceAll('>','›');
  const lines = parts.map(b => [b.text && safe(b.text),b.link && (format === 'markdown' ? `[${safe(b.link.label)}](${b.link.url.replace(/[()\\]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase())})` : `${safe(b.link.label)}: ${safe(b.link.url)}`)].filter(Boolean).join('\n'));
  return [...(r.template === 'ack' ? [] : [safe(title)]),...lines].join('\n\n');
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
