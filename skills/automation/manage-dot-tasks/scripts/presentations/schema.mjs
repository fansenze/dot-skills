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

export const responseTitles = {ack:'收到',list:'任务列表',detail:'任务详情',decision:'需要你确认',brief:'定时简报'};
