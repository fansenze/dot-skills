/** Bounded, data-only projection of provider text/post content. No I/O or evaluation. */
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function decode(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > 262144) return null;
    try { return JSON.parse(value); } catch { return null; }
  }
  return object(value) ? value : null;
}
function postBody(value, depth = 0) {
  if (depth > 4) return null;
  const body = decode(value);
  if (!body) return null;
  if (Array.isArray(body.content)) return body;
  // Select a single representation and language; never concatenate translations.
  for (const key of ['post', 'zh_cn', 'en_us', ...Object.keys(body).filter(k => /^[a-z]{2}_[a-z]{2}$/.test(k)).sort()]) {
    if (!Object.hasOwn(body, key)) continue;
    const found = postBody(body[key], depth + 1);
    if (found) return found;
  }
  return null;
}
function projectPost(value) {
  const body = postBody(value);
  if (!body || body.content.length > 4096 || (body.title !== undefined && typeof body.title !== 'string')) return null;
  const lines = body.title ? [body.title] : [];
  let nodes = 0, omitted = false;
  for (const line of body.content) {
    if (!Array.isArray(line)) return null;
    const parts = [];
    for (const node of line) {
      if (++nodes > 4096 || !object(node)) return null;
      if (['text', 'md', 'code_block'].includes(node.tag) && typeof node.text === 'string') parts.push(node.text);
      else if (node.tag === 'a') {
        const label = typeof node.text === 'string' ? node.text : '';
        let href;
        try {
          if (typeof node.href === 'string' && !/[\s\x00-\x1f\x7f]/u.test(node.href)) {
            const url = new URL(node.href);
            if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) href = node.href;
          }
        } catch { /* Keep only the visible label for unsupported links. */ }
        parts.push(href ? (label && label !== href ? `${label} (${href})` : href) : label);
        if (!href) omitted = true;
      } else if (node.tag === 'at' && typeof node.user_name === 'string') parts.push(node.user_name);
      else { omitted = true; parts.push(' '); }
    }
    lines.push(parts.join(''));
  }
  return {text: lines.join('\n'), ...(omitted ? {text_omitted: true} : {})};
}
export function extractReadableContent(message) {
  if (!['text', 'post'].includes(message.message_type)) return {};
  for (const source of ['content_v2', 'content']) {
    const raw = message[source];
    if (raw === undefined) continue;
    let result;
    try {
      if (Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw)) > 262144) continue;
      result = message.message_type === 'post' ? projectPost(raw) : {text: decode(raw)?.text};
    } catch { continue; }
    if (typeof result?.text !== 'string' || !result.text.trim()) continue;
    // Fail closed on an oversized/unsafe chosen projection; never truncate an instruction.
    if (result.text.length > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result.text)) return {};
    return {...result, text_source: source};
  }
  return {};
}
