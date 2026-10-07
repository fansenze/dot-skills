# Per-task dot and Feishu conversations

This is an explicit, task-scoped conversation contract inside Manage Dot Tasks.
It adds one durable, ordered, append-only chat history to an existing task. It
does not turn every dot conversation, Codex turn, task event, or Feishu message
into a broadcast. Read [connector authorization](connectors.md) and
[scheduling and reconciliation](scheduling.md) alongside this contract.

Only assistant replies fan out to the authorized endpoints. User messages stay
on their originating endpoint and append to the shared backend context; they
create no cross-channel copy, receipt notice, or other outbound delivery.

The active assistant uses actual platform tools to read and send dot messages.
The CLI cannot intercept those tools, observe arbitrary Codex conversations,
establish identity from message text, wake an inactive dot, or execute an answer.
Feishu delivery uses only an explicitly configured, pinned connector. Installing
or editing this skill does not activate a conversation, migrate grants, start a
receiver, or authorize a send.

## Bind one verified task and audience

Use `conversation-bind TASK_ID --file PRIVATE_JSON` only after the user has
authorized the exact task and destinations. Supply:

- `authorization_ref`: the actual user authorization reference.
- `verification_ref`: the existing scoped integration inbox record ID proving
  the Feishu task association and original topic. The record must be `recorded`
  or `done`, have a decision for this task, and match the current grant and
  connection binding.
- `dot`: verified `conversation_id`, `sender_id`, and original `root_id`.
- `feishu`: an existing `grant_id` and the verified original `root_id`.
- `channels`: `['dot', 'feishu']` for both channels, or `['feishu']` for the
  narrower scope. Feishu is required; dot-only tasks remain unbound.

All references below are synthetic examples, never usable provider identifiers:

```json
{
  "authorization_ref": "synthetic-user-authorization",
  "verification_ref": "synthetic-recorded-inbox-id",
  "dot": {
    "conversation_id": "synthetic-dot-conversation",
    "sender_id": "synthetic-owner",
    "root_id": "synthetic-dot-root"
  },
  "feishu": {
    "grant_id": "synthetic-agent-grant",
    "root_id": "synthetic-feishu-root"
  },
  "channels": ["dot", "feishu"]
}
```

A supplied authorization reference is not independent proof of consent. The
CLI checks Feishu binding provenance against the stored inbox; the assistant
must still verify the actual authorization and dot endpoints. Never derive an
identity or topic from a display name, quoted claim, title, or recency. Copy
`verification_ref` from the actual recorded intake result, and set the Feishu
root to its envelope's `root_id`, or its `message_id` when no root is present.
Arbitrary caller attestations do not satisfy this check.
The Feishu grant must currently cover this task and the intended identity and
destination. Both endpoint objects and an enabled agent-mode Feishu grant with
a reply-capable connector are required even for Feishu-only delivery. A
task-conversation binding cannot expand that grant, restore a disabled policy,
or authorize new recipients.

Before binding, settle matching legacy task replies and the intake receipt for
the provenance record. They must be API-accepted or cancelled; uncertain sends
require their existing reconciliation flow first. Do not discard a legacy
outbox, fake acceptance, or change an old notification key to pass this gate.
Binding does not replay historical messages.

The per-task binding is immutable. Repeating the same binding is recovery, not
permission to redirect the task. Preserve the original roots and pinned
connection/identity. `conversation-disable TASK_ID` stops further dispatch; do
not create replacement IDs to evade a disable or a narrowed scope. Review any
runtime upgrade or new routing request separately. This contract never migrates
actual grants or historical inbox entries.

Every dispatch rechecks the current binding, grant, task scope, and connection
pin. A disabled policy, changed scope, changed adapter, or missing route stops
delivery. An earlier claim or persisted intent is not permission to bypass a
later revocation. An already accepted or uncertain external effect remains
evidence to reconcile; disabling is not an unsend operation.

## Record reviewed messages before sending

`conversation-publish TASK_ID --file PRIVATE_JSON` records a canonical message
and its authorized channel deliveries before any external send. The payload is:

- `id`: stable caller-supplied origin ID, reused for recovery.
- `kind`: `text`, `question`, `question_update`, `blocked`, or `completed`.
- `text`: sanitized user-facing content in the user's language, at most 4,000
  characters.
- `privacy`: `reviewed`.
- `audience`: `shared`.
- `format`: `text`, `markdown`, or `card`.
- Optional `response`: one of the existing [semantic response
  templates](reply-presentations.md). Its `lead` must exactly equal `text`, and
  `format_override` is not allowed; the canonical message's `format` is explicit.
- For a question: `question_id`, `question_revision`, and optional
  `permission_class: "ordinary_text"` (also the default). Use the explicit
  ordinary-text class in reviewed examples.

```json
{
  "id": "synthetic-release-format-question-1",
  "kind": "question",
  "text": "Which release format should I prepare: PDF or slides?",
  "privacy": "reviewed",
  "audience": "shared",
  "format": "text",
  "question_id": "synthetic-release-format",
  "question_revision": 1,
  "permission_class": "ordinary_text"
}
```

The assistant reviews both the content and the audience before publishing.
`privacy: "reviewed"` is a caller attestation, not a secret detector or new
permission. Never publish credentials, raw private logs, unrelated conversation
history, or sensitive details lacking the required sharing authorization.
Forward only the minimum sanitized text needed to understand this task.
The known-secret heuristic is defense in depth and cannot establish that text
is safe. JSON input files are bounded to 32,000 bytes. Unknown input fields are
rejected rather than interpreted as extra routing or permission instructions.

Platform-native approval widgets, secure login or security handoffs, and their
tokens are excluded. A card or an ordinary-text answer cannot replace a native
approval, required action-time confirmation, or user-only handoff. If a question
needs such a mechanism, use the original platform flow and report only an
authorized, nonsensitive status summary in the other channel.

Canonical message IDs and provider-origin IDs must be stable and unique.
Identical retries reuse the original record; changed content must not reuse an
old identity. Use provider receipts and the stored task/root binding for
correlation. A similarly named or recently active task is never a substitute.

### Completion-only defaults remain intact

Existing watches and associated notifications remain completion-only. This
contract does not subscribe them to progress, reopen tasks, or manufacture a
completion event. Explicit task questions and actionable `blocked` messages are
needed-answer exceptions addressed to this bound conversation using one stable
canonical ID. They are not a general progress feed.

The normal verified transition through `complete` atomically records one
canonical `completed` message for an active binding, using a stable task/work
revision ID and the completion summary. The notification uses the shared completion
projection (outcome, result links and time) and the grant's selected format.
Review that content for the bound audience before completing the task. Do not publish another completion message
to duplicate it; read `conversation-show` and reuse its actual canonical ID when
linking the result to an intake decision. Explicit `conversation-publish` with `kind: completed` also
requires an already completed task and never completes one by itself.

Legacy watches and associated completion notices are suppressed only for the
bound task's matching connector, account, and chat destination while that route
is actively owned by the task conversation. Independently authorized routes
remain intact. The stored legacy policies are not rewritten or migrated. Routine
polls, logs, and intermediate ledger updates stay local.

## Integrate with the active intake loop

`start` now attempts both the existing legacy outbox and eligible canonical
Feishu deliveries. It returns their actual delivery results in `notifications`;
inspect them instead of assuming success. It also claims at most one dot
delivery in `conversation_deliveries.dot`. Process that returned claim through
`conversation-begin → actual platform send → conversation-receipt`; do not call
`conversation-next` to replace an already live claim. Dot delivery still requires
the active assistant's actual messaging tool. Neither path wakes an inactive assistant.
Standalone `deliver` handles legacy notices; `conversation-deliver` handles
canonical Feishu deliveries.

`start` also returns bounded `conversation_issues` for stopped or uncertain
deliveries (`delivery_unknown`, `not_sent`, or `api_error`), including after a
restart. Read the affected task with `conversation-show` and reconcile the
original attempt once authoritative evidence is available. An unchanged issue
is not a request to send another warning, publish another message, or run a tight
retry loop. Preserve the active task's normal wait cadence and pending blocker.

`message-next` and `start` claims include `context.task_conversation`. Matching
uses the exact bound grant and original root or accepted provider receipts,
never message text, task title, or recency. Context includes at most 20 matching
tasks and the last 20 questions and canonical messages for each, with
`total_matches`, `total_questions`, and `total_messages` counts exposing partial
coverage. Read `conversation-show` for a task's full ledger. Multiple matches
require clarification rather than a guess.
For an exact active bound topic, default/legacy connectors still suppress the old automatic intake acknowledgement, so `acknowledgement: null` can be expected there. A Feishu channel with reaction support instead follows the [topic receipt policy](feishu-presentation.md): first admitted message gets text, later messages get `Get`. The incoming envelope is still durably ingested and must be reviewed normally; a reaction is not the substantive canonical answer.

When a `message-record` decision refers to an actively bound task, or replies in
its exact bound topic, first append that verified incoming message through
`conversation-input`. Then publish the reviewed assistant reply. Include that
record's `canonical_message_id` in the decision file. Its legacy `reply`, or its
structured `response.lead`, must exactly match the canonical `text`. A structured
`response` must also match the canonical stored response in full. For example,
a clarification in an already matched topic can use:

```json
{
  "decision": "clarify",
  "summary": "Asked which release format to prepare",
  "reply": "Which release format should I prepare: PDF or slides?",
  "canonical_message_id": "synthetic-current-assistant-reply"
}
```

Do not add a `task_id` to a clarification/rejection; the existing decision schema
still applies and exact topic context supplies the match. A query or continuation
for a bound task must likewise use its canonical reply. Successful recording
links the decision without enqueueing a second legacy reply. Unbound intake
keeps its existing behavior; it cannot claim a canonical ID from another task.
The incoming shared record must match the decision's actual inbox evidence ID
and provider message ID. The assistant reply must have a later canonical
sequence than that input. Replace the example ID with the new reply's actual ID;
an earlier published question cannot stand in for a reply to a later input.
This link does not process user input, schedule work, or execute an action.
Append verified user text with `conversation-input`, read the shared history,
and use the normal scheduling/acknowledgement workflow after checking authority.
`conversation-answer` is the question-referenced form of the same input path;
it does not introduce a separate approval or voting workflow.

## Dispatch and retain receipts

Commands use `taskctl` as shorthand for
`node "$SKILL_DIR/scripts/taskctl.mjs"`. Global `--store` precedes the command.

```bash
taskctl conversation-show TASK_ID
taskctl conversation-next --channel dot --consumer ACTIVE_CONSUMER --lease-ms 120000
taskctl conversation-begin DELIVERY_ID --token RETURNED_TOKEN
# Only proceed: true permits the active assistant's actual dot send.
taskctl conversation-receipt DELIVERY_ID --token RETURNED_TOKEN --file PRIVATE_RESULT_JSON

# Feishu adapter delivery consumes only its authorized channel entries.
taskctl conversation-deliver --consumer ACTIVE_CONSUMER
```

`conversation-next` claims one pending delivery. Its lease defaults to 120000 ms
and must be a positive integer no greater than 3600000. It returns `null` when
no eligible delivery exists. It preserves order per task and channel: a stopped
or uncertain earlier delivery blocks later ones in that channel until resolved.
It does not return a claim that authorizes resending an uncertain entry.
`conversation-deliver` also accepts `--lease-ms N` and `--limit N` (default 10,
range 1–100).

For dot, the assistant first claims a delivery, then durably records send intent
with `conversation-begin`. It invokes the actual platform messaging tool only
when the current result says `proceed: true`. Send the frozen text to the exact
verified conversation/root; do not guess or reconstruct a provider message ID.
Use the claim's `delivery_text`, which includes the plain-text rendering of an
optional structured response. Sending only its lead would lose options or
supporting sections. The dot surface uses plain text even if another channel
uses Markdown or cards.
Record the actual result with the claim's token. A lease is fencing, not proof
that a tool succeeded or permission for another send.

The normalized send result uses the existing [connector result
contract](connectors.md#adapter-interface-and-schemas): `idempotency_key` and
`status`, with a real `message_id` required for `api_accepted`. Preserve returned
`parent_id`, `root_id`, and `thread_id` when available. API acceptance is not proof
of delivery to the human or of a read. Keep original anchors and provider
receipts so a later reply can be traced to the exact task and question revision.

Canonical delivery IDs remain unchanged in the ledger and its receipts. At the
Feishu connector boundary, IDs longer than 50 characters use the transport key
`chat-v1-` followed by the first 40 hexadecimal characters of the original ID's
SHA-256 hash (48 characters total). IDs of at most 50 characters pass through
unchanged. Validate the returned transport key before associating the result
with the canonical delivery ID; a wrong or missing key is `delivery_unknown`,
even if the result claims acceptance. Reconciliation reuses the same mapping
and never grants an automatic retry of an uncertain send.

`not_sent` means authoritative evidence that the attempt did not send;
`api_error` means a definite API rejection. Missing, malformed, mismatched,
timed-out, or otherwise uncertain results are `delivery_unknown`. Never record
a fabricated message ID, derive acceptance from a successful local process, or
call an uncertain send a safe failure.

After a crash or an ambiguous result, read `conversation-show TASK_ID` and the
recorded delivery state before retrying. An interrupted `sending` lease becomes
`delivery_unknown`; an expired claim with no recorded send intent becomes
pending. Reconcile the actual provider effect.
Use `conversation-resolve DELIVERY_ID --file PRIVATE_RESOLUTION_JSON` only with
conclusive evidence of acceptance or no send. Its fields are `status`
(`api_accepted` or `not_sent`), `evidence`, and a real `message_id` when accepted:

```json
{
  "status": "api_accepted",
  "message_id": "synthetic-verified-provider-message",
  "evidence": "synthetic-authoritative-provider-result-reference"
}
```

Use the actual evidence and message ID, never these example values. Resolution
is permitted only for stopped `delivery_unknown`, `not_sent`, or `api_error`
entries with no live lease. A conclusive `not_sent` resolution requeues the same
delivery for a new claim; it never changes the canonical message or route.
No-send evidence must also rule out an earlier worker still producing the
effect. No search match, incomplete
history, elapsed time, and an expired lease are not conclusive no-send evidence.
Never avoid uncertainty with a fresh origin ID, delivery, root, or destination.

## Append verified user messages

Use `conversation-input TASK_ID --file PRIVATE_JSON` for ordinary task messages
from either channel. The active assistant reads the actual message through
authorized tools, verifies its identity and task/topic context, reviews privacy,
and appends one projection. `conversation-answer` uses the same append path but
requires a question reference; it is not a questionnaire or approval engine.

The input fields are:

- `id`: stable caller-supplied input ID.
- `channel`: the actual `dot` or `feishu` origin.
- `provider_message_id`: the actual incoming platform message reference.
- `identity`: exact verified platform envelope identity. Dot uses
  `{conversation_id, sender_id}`; Feishu uses
  `{account_id, tenant_id, sender_id, destination_id}` from the bound grant.
- `occurred_at`: the platform's timezone-aware timestamp, retained as source
  metadata. It does not sort or replace the local append order.
- `in_reply_to`: the bound root or an accepted provider receipt in the same
  task/channel. With question references, use that question's canonical message
  ID or its accepted receipt; either requires accepted delivery in that channel.
- `text`: reviewed content, at most 4,000 characters. A non-redacted Feishu
  projection must exactly equal its stored envelope text.
- `privacy`: `reviewed`, and `audience`: `shared`.
- `evidence_ref`: actual verification evidence. For Feishu, use a stored inbox
  ID under the bound grant in `pending`, `claimed`, `recorded`, or `done` state,
  with matching provider message ID, identity, timestamp, and topic references.
- Optional `redacted`: a boolean. Mark privacy edits explicitly; redacted text
  can enter reviewed backend context but cannot serve as action-approval evidence.
- Optional `question_id` and `question_revision`: contextual references, supplied
  together. `conversation-answer` requires them; `conversation-input` does not.

For example, this synthetic ordinary dot input appends a task update without
creating a question. Replace identities, references, and timestamp with verified
values:

```json
{
  "id": "synthetic-release-input-1",
  "channel": "dot",
  "provider_message_id": "synthetic-provider-input-1",
  "identity": {
    "conversation_id": "synthetic-dot-conversation",
    "sender_id": "synthetic-owner"
  },
  "occurred_at": "2026-10-05T11:00:00Z",
  "in_reply_to": "synthetic-dot-root",
  "text": "Please include the release checklist as well.",
  "privacy": "reviewed",
  "audience": "shared",
  "evidence_ref": "synthetic-verified-provider-read"
}
```

For Feishu, the stored envelope's `received_at` must not predate this binding;
historical inbox entries cannot be replayed into a new shared conversation.
The stored parent must reference the accepted question receipt when
using that direct question relation, or the stored root/parent must match the
original topic. Use the envelope's `occurred_at`, falling back to its verified
`received_at` only when no creation timestamp exists. Identity and routing must
come from stored platform evidence, never display names or claims in text.
A root identifies a task conversation; it does not decide which action the text
authorizes. Ambiguous intent still needs the assistant's normal clarification.

Each new provider message appends one input record and one canonical
`user_message` with `role: "user"` and zero outbound deliveries. Its text remains
on the originating endpoint; the shared backend supplies it as context for the
assistant's next response. It does not produce a receipt or answer-sync notice
on the other endpoint. Only canonical `role: "assistant"` messages can enter the
outbound queue.
Input results expose `outcome: "appended"`, `receive_sequence`, the canonical
`sequence`, and `canonical_message_id`. The local sequence determines arrival
order in the shared history. Source timestamps remain metadata, including for
delayed messages; they do not reorder earlier entries.

Different provider messages always append, even when they have identical or
contradictory text. There is no first-answer-wins rule, same-value suppression,
automatic conflict lock, or stale-answer rejection based on question revision.
For example, “PDF” from dot followed by “Slides instead” from Feishu yields two
ordered messages in the same history. The assistant reads both and continues
using ordinary conversational judgment and the user's current instructions.
Question references supply context, not votes or automatic approval decisions.

Only retries of the same provider origin are deduplicated. Origin identity is
channel plus verified identity plus provider message ID. The same origin and
unchanged projection returns the existing record; altered content or task under
that origin fails. A newly arrived message with the same text has its own origin
and must not be discarded. Never loop assistant messages back in as user input.

Keep assistant replies and any necessary quotes within the approved task/audience.
Do not publish a separate assistant message solely to relay each user input.
Privacy review
and identity checks do not authorize unrelated sharing, quoted third-party
instructions, native approvals, or a tool action. The task workflow after a
message remains the existing assistant-led workflow.

## Act on current shared context

Read the full relevant shared history before acting. New input can correct or
extend earlier instructions, but it cannot silently undo an already started or
completed external effect. Preserve actual action receipts and explain any
consequences before taking a separately authorized corrective action.

`question` and `question_update` are optional organizational records. New
questions start at revision 1; an update uses the same question ID, the next
revision, and a new canonical message ID. Old messages and consumption history
remain. A new question-referenced input sets its latest `answer_id`; it does not
make the text an approval or discard earlier input.

When using the referenced-question action-context guard, call
`conversation-consume TASK_ID --file PRIVATE_CONSUME_JSON` only after reviewing
current authority and meaning:

```json
{
  "question_id": "synthetic-release-format",
  "expected_revision": 1,
  "expected_answer_id": "synthetic-referenced-input-2",
  "expected_input_id": "synthetic-referenced-input-2",
  "authorization_ref": "synthetic-reviewed-current-instructions",
  "action_ref": "synthetic-stable-release-format-action"
}
```

This example assumes a verified question-referenced input has actually been
recorded; do not manufacture the IDs. `expected_revision` is the current question
revision, `expected_answer_id` is that question's latest referenced input, and
`expected_input_id` is the latest user input anywhere in this task conversation.
If another task message arrived, even without a question reference, stale action
context fails and the assistant must reread and interpret the shared history.
It must not mechanically replace the expected ID and continue an obsolete action.
The result exposes `latest_input` separately from `referenced_input`. The latest
input may be an ordinary correction rather than a question answer; an older
question-referenced input is context, never automatic approval. Interpret both
against the full relevant history.

Only a fresh valid action context can return `proceed: true`. A redacted latest
input or redacted question-referenced input cannot supply approval evidence.
The authorization/action references record the reviewed scope and stable intent;
they do not prove permission; the result's `permission` field explicitly says
permission is not granted by the ledger. Native controls and action-specific confirmation
requirements still apply.

Consumption never executes a tool. Use the normal durable scheduler
`begin → actual tools → record → ack`, or the actual platform's equivalent
reconciliation flow. Consumption records remain append-only across messages and
question updates. An already consumed `action_ref` returns `proceed: false` with
reconciliation information; use a new reference only for genuinely new authorized
work. A later user message can support a new action after ordinary review without
rewriting or rerunning the old action. An uncertain external result requires
provider-state reconciliation, never another input ID or action ID as a retry
shortcut.

## Acceptance and limits

Use isolated stores, fabricated identities, and mocked connectors for repository
checks. Verify stored binding provenance, immutable routes, original roots,
canonical intake linking, append ordering, provider-origin retry deduplication,
distinct identical/contradictory messages with no user-message deliveries,
assistant-only fanout, current-context action guards,
append-only consumption history, revoked-scope fencing, uncertain-delivery
reconciliation, and completion-route deduplication. Local checks do not prove
live dot/Feishu delivery, wake-ups, complete platform coverage, native approval
validity, or an actual task outcome.

Inspect conversation state separately from task state, scheduler state, and
legacy notification state. List/detail notification summaries include canonical
delivery state, and unresolved delivery remains inspectable in detail/history views and the delivery queue. The default list includes only the ten most recently updated active tasks. Report blocked or uncertain stages accurately. Do not
activate the workflow or migrate a real binding merely to validate this file.
