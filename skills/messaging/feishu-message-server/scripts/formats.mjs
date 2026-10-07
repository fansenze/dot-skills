/** Explicit wire-format support. No silent Markdown-to-text conversion. */
import { SafeError } from './config.mjs';

export const CAPABILITIES = Object.freeze({protocol_version: 1, name: 'feishu-message-server',
  formats: ['text', 'markdown', 'card'], send: true, reply: true, receive: true, durable_cursor: true,
  presentation:'feishu', react:true, delivery_receipts: 'api_acceptance_only', automatic_retry: false});

export function formatContent(format, input) {
  if (format === 'text') return {msg_type: 'text', content: JSON.stringify({text: input})};
  if (format === 'markdown') {
    if (typeof input !== 'string' || !input.trim() || !input.isWellFormed()) throw new SafeError('Markdown must be non-empty valid Unicode');
    // Tables need explicit native columns, not an unsupported Markdown table.
    if (/^\s*\|.*\|\s*$/m.test(input)) throw new SafeError('Markdown tables require explicit card columns');
    return {msg_type: 'interactive', content: JSON.stringify({schema: '2.0', body: {elements: [{tag: 'markdown', content: input}]}})};
  }
  if (format === 'card') {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (input.schema !== '2.0' && !Array.isArray(input.elements)) || (input.schema === '2.0' && !Array.isArray(input.body?.elements))) {
      throw new SafeError('Card must have JSON 1.0 elements or a JSON 2.0 body.elements array');
    }
    return {msg_type: 'interactive', content: JSON.stringify(input)};
  }
  throw new SafeError('Unsupported format; choose text, markdown or card');
}
