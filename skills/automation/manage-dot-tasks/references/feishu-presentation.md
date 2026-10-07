# Feishu presentation and topic receipts

## Responsibility boundaries

1. `presentation.mjs` builds semantic task content. Completion notifications carry the completion summary, safe result links, coverage and actual completion time. Explicit detail queries retain goals, steps, checks, blockers and next actions. Evidence stays in the ledger; do not write technical acceptance logs into the user-facing completion summary.
2. `reply-presentation.mjs` routes presentation. `presentations/schema.mjs` validates plain semantic content; `presentations/default.mjs` owns the default Markdown/text layout; `presentations/feishu.mjs` owns native card components and Feishu topic-receipt policy. Routing does not construct provider components or interpret user intent.
3. The integration owns scoped authorization, intake deduplication and the transactional outbox. It freezes the chosen operation and wire payload before dispatch. The selected channel never changes the recipient, task scope or permissions.
4. Connectors transport the frozen payload. Both direct Feishu and Remote Config Bridge advertise `presentation: "feishu"` and `react: true`; both use the same task-skill renderer. The bridge has no separate card layout. Feishu Message Server implements the official SDK calls and resident operation journal, with no automatic actions in its receiver.

Ordinary local/dot replies default to Markdown. An explicit connected route selects Feishu; merely installing a skill does not select or start a service. Explicit format overrides remain supported. Existing frozen message bodies keep their original bytes during recovery.

## Native card layout

The renderer uses Feishu JSON 1.0 components supported by the transport:

- A native header with a colored `text_tag_list` status; no separate status paragraph.
- Normal 14px body text, 16px task item titles, and gray 12px `notation` section labels.
- Compact columns for related content; a single section item is a paragraph. Multiple items retain an existing check/step marker without adding a second bullet.
- Gray status-group labels, 24px group margins and separating rules preserve clear task-list boundaries.
- Actual timestamps, source and coverage in a small footer; the display timezone is Beijing time (Asia/Shanghai). Rendering never changes the stored timestamp or acceptance state.
- Plain-text nodes for authored content and native URL buttons for reviewed HTTP(S) links. Choices remain text and do not execute actions.

Official contracts: [plain text and sizes](https://open.feishu.cn/document/feishu-cards/card-components/content-components/plain-text), [columns and spacing](https://open.feishu.cn/document/feishu-cards/card-components/containers/column-set), and [header status tags](https://open.feishu.cn/document/feishu-cards/card-components/content-components/title).

## Receipt policy

For an authorized Feishu agent-mode intake:

- The first admitted message in a topic creates a new short text receipt, `收到，正在处理。` (or the configured English equivalent), with a message ID on API acceptance.
- Each subsequent admitted message in that topic queues one `react` operation targeting that incoming message with `emoji_type: "Get"`. The second, third and later reactions each use the current incoming message ID, never the topic root or a bot reply. The value is case-sensitive. It creates no extra receipt message.
- Topic identity uses actual `message_id`, `parent_id`, `root_id` and `thread_id`, plus accepted bot reply references and already verified canonical conversation roots. It is scoped to the immutable connector binding, grant, account, tenant and chat. Different admitted senders in the same group topic share the receipt policy; this does not share their task authority or private context.
- A new unthreaded message without provider references starts a new topic. Do not guess a topic from text, task title, elapsed time or the newest task. The first message observed in an existing thread still gets the initial receipt when no earlier admitted message is known.
- Choose and persist the receipt during intake under the existing store lock, before advancing the checkpoint. A duplicate event, another batch, process restart or later delivery cannot change that decision or enqueue another receipt.

Other connectors retain their existing acknowledgement policy, including canonical-conversation suppression. Feishu receipts are separate from substantive answers, task completion and message processing acknowledgements. Inspect the claim's `acknowledgement.operation`, state and receipt; `start` attempts the durable receipt before handing off work. Reaction failures do not authorize a replacement text receipt or rerunning the task.

The official [reaction API](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create) is `POST /open-apis/im/v1/messages/:message_id/reactions` with `reaction_type.emoji_type`. The official [emoji list](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-reaction/emojis-introduce) specifies `Get`. The application needs `im:message.reactions:write_only` or its existing broader `im:message` permission and access to the message's chat. Missing permission remains an API error; repository work does not grant it or send a probe.

## Delivery recovery

Reaction acceptance requires an actual `reaction_id`, not a message ID. Outbox intent freezes the exact target and emoji. Resident and bridge journals replay the same key/result without redispatch; unknown outcomes never fall back to text or retry automatically. Reaction receipts are excluded from bot-message reply references. Reconcile an unknown outcome only with conclusive evidence:

```bash
taskctl resolve-notice NOTICE_ID --status api_accepted --reaction-id ACTUAL_REACTION_ID --evidence VERIFIED_RECEIPT_REF
```

The Feishu API has no message `uuid` field for reactions; the local resident and bridge journals provide operation-key replay protection. Preserve those journals. Explicit standalone operation bypasses the resident journal and must not be used to evade an uncertain receipt.

## Verification

Local tests cover native payload structure, default Markdown, completion/detail separation, topic references, isolation, batch/restart deduplication, disabled policies, frozen unknown results, actual SDK reaction request shapes, resident replay and bridge replay. Use synthetic data and temporary stores; no real credentials are required.

Visual acceptance must import the exact output from `renderResponse(response, 'card')` into the [official card builder](https://open.feishu.cn/tool/cardbuilder) and inspect desktop and mobile layouts. An independently styled HTML mockup is not acceptance of the native card. Check completion, explicit detail, mixed-state/empty lists, blockers, failed requests, clarification options and recurring briefs. Browser login, provider permissions and live delivery remain separate from successful local tests. Send a preview only when the destination and content are authorized.
