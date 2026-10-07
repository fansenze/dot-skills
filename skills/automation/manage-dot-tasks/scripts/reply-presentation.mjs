/** Presentation routing and shared response API. Channel implementations own layout. */
import {validateResponse} from './presentations/schema.mjs';
import {renderDefaultResponse, renderDefaultDocument, defaultReceipt} from './presentations/default.mjs';
import {renderFeishuResponse, renderFeishuDocument, feishuReceipt, validFeishuReceipt} from './presentations/feishu.mjs';
export {validateResponse} from './presentations/schema.mjs';
const fail = message => { throw new Error(`Invalid response: ${message}`); };
export function renderResponse(value, format = 'markdown') {
  if (!['text','markdown','card'].includes(format)) fail('render format');
  const response = validateResponse(value);
  return format === 'card' ? renderFeishuResponse(response) : renderDefaultResponse(response, format);
}
export function renderConnectorDocument(caps, format, document) {
  return caps.presentation === 'feishu' ? renderFeishuDocument(document, format) : renderDefaultDocument(document, format);
}
export function validReceiptPresentation(caps, notice, incoming) {
  return caps.presentation === 'feishu' && caps.react === true && validFeishuReceipt(notice,incoming);
}
export function receiptPresentation(caps, context) {
  if (caps.presentation === 'feishu' && caps.react) return feishuReceipt(context);
  return defaultReceipt(context);
}
export function responseDocument(value, updatedAt = new Date().toISOString()) {
  const response = validateResponse(value);
  return {updated_at:updatedAt,response};
}
export function responseFormat(doc, fallback, caps) {
  const response = validateResponse(doc.response), formats = caps.formats;
  const chosen = response.format_override?.format ?? (response.template === 'ack' && formats.includes('text') ? 'text' : fallback);
  if (!formats.includes(chosen)) fail('requested format is unsupported by this connector');
  return chosen;
}
