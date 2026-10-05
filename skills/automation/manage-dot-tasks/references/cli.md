# Commands and Examples

All commands start with `node "$SKILL_DIR/scripts/taskctl.mjs"`. Examples use `taskctl` as shorthand; no global executable needs to be installed.

- `--store PATH`: select the store; takes precedence over `DOT_TASKS_HOME` and platform defaults. Global options precede the command.
- `--lock-timeout SECONDS`: wait for the local lock, default 10 seconds.
- Structured commands return JSON; view commands return Markdown unless writing an output file. Errors exit with code 2.
- Use `taskctl --help` or `taskctl COMMAND --help` for options.

On macOS the default is `~/Library/Application Support/manage-dot-tasks/task-store`. Linux with `/workspace/shared` retains `/workspace/shared/dot-tools/task-store`; other Linux systems use `$XDG_DATA_HOME/manage-dot-tasks/task-store`, falling back to `~/.local/share` when that variable is unset or relative.

System aliases such as macOS `/tmp` and `/var` work without changing `TMPDIR`. Store roots and outputs resolve to physical paths, including directory aliases, relative paths, and missing child directories. Returned output paths identify the actual file. Store-internal files, task directories, locks, and recovery journals reject symlinks. Physical-path checks prevent aliases, case variants, or `..` from overwriting the store or skill source.

## Initialization and assistant memory

`taskctl init` creates local files or reuses an existing valid store. It is idempotent and preserves existing configuration and tasks. The `initialized` boolean reports whether new files were created, not whether the assistant's entire setup is complete.

Every successful `init` returns `initialization_scope: "local_files_only"` and `assistant_memory.status: "not_checked"`. The CLI neither reads nor writes platform memory. It cannot return a verified memory outcome or infer one from a repeated initialization, metadata, or a note. During assistant-led installation or first activation, the assistant must continue with [first-use.md](first-use.md) and use the platform's existing memory to save the authorized operational rules in the same turn. Existing authorization does not need another confirmation. Verify persistence, reuse matching conventions, and report unavailable or failed steps accurately.

## A complete task

```bash
taskctl init
taskctl register --id task-release --title "Prepare release materials" --goal "Deliver reviewed release materials" --next-action "Collect changes"
taskctl update task-release --status executing --reason "Starting preparation"
taskctl step task-release --title "Collect changes" --state executing
```

Use the actual stable step ID returned by the last command; do not guess it.

```bash
taskctl step task-release --step-id STEP_ID --state completed --evidence "Changes reviewed item by item"
taskctl result task-release --label "Release materials" --url "https://example.com/verified-report"
taskctl update task-release --status awaiting_verification --reason "Materials prepared for final review" --next-action "Check content and access"
taskctl check task-release --name "Content and links" --outcome pass --evidence "Opened the materials, checked their contents, and verified recipient access"
taskctl complete task-release --summary "Materials verified and delivered" --evidence "See the content and links check and the actual delivery result"
```

The example URL illustrates syntax; replace it with a verified result. `complete` does not send anything. Record delivery only after delivery actually happened. Keep user-supplied task text in its original language.

## Command reference

- `init [--stale-hours 24] [--snapshot-note TEXT]`: initialize or reuse a local store; platform memory remains unverified by the CLI.
- `register --title TEXT --goal TEXT [--id ID] [--status STATE] [--blocker TEXT] [--next-action TEXT] [--summary TEXT] [--source TEXT] [--source-ref REF]`: with both source fields, atomically create or reuse a source identity without overwriting an existing task.
- `update ID [--title TEXT] [--goal TEXT] [--status STATE --reason TEXT] [--blocker TEXT] [--next-action TEXT] [--summary TEXT]`
- `step ID [--step-id STEP_ID] [--title TEXT] [--state queued|executing|completed|skipped] [--evidence TEXT]`
- `event ID --text TEXT [--kind note|progress|decision|blocker] [--source TEXT]`: append a user-appropriate factual event.
- `observe ID --state STATE --source TEXT [--observed-at TIMESTAMP] [--run-id REFERENCE] [--source-version N]`
- `check ID --name TEXT --outcome pass|fail --evidence TEXT [--checked-at TIMESTAMP]`
- `result ID --label TEXT --url URL`: record a verified HTTPS, HTTP, or Library result link; credential-bearing and script URLs are rejected.
- `complete ID --summary TEXT --evidence TEXT`: record verified completion using current checks.
- `list [--status STATE] [--all]`: return the lightweight index; completed tasks inactive for ten minutes are hidden by default.
- `show ID`: return the full task record.
- `render list [--all] [--output FILE]`: render the three-column list with the same default filter.
- `render detail ID [--output FILE]`: render a concise detail view; use `show` for the full record.
- `render bundle [--all] --output DIRECTORY`: generate a list and linked detail files.
- `render ... [--language en|zh]`: select fixed view labels; English is the default. User content is not translated.
- `render ... [--templates DIRECTORY]`: use custom `list.md` and `task-detail.md` templates.
- `doctor` / `verify`: check local structure, index, projections, and completion records. These commands do not perform external acceptance checks or verify memory.

Single-task mutation commands accept `--expected-revision N`. Read the current `revision` from `show` before writing to prevent stale updates.

## Scheduling commands

Read [scheduling.md](scheduling.md) for the required authorization, source discovery,
active loop and reconciliation rules. Task IDs below refer to existing task
records; request IDs are local scheduling identities, never platform task IDs.

- `bind TASK_ID --source SOURCE --source-ref REF`: bind another verified identity; reject conflicts.
- `lookup --source SOURCE --source-ref REF`: return a binding or JSON `null`.
- `coverage`: read recorded source coverage. To write a source/scope observation, use `coverage --source SOURCE --scope SCOPE --state partial|complete|unavailable --evidence TEXT [--observed-at TIMESTAMP]`. No platform query occurs.
- `schedule TASK_ID --event-id EVENT_ID --request-id REQUEST_ID --source SOURCE --source-ref REF --action execute|observe|verify --authorization-ref REF --work-revision N [--step-id ID] [--check-name TEXT] [--not-before TIMESTAMP] [--max-attempts N]`: durable immediate/delayed scheduling. Verification requires a check name; other actions reject it. Default attempt budget 5, range 1–100.
- `queue [--task-id ID] [--all]`: return requests; done/cancelled are hidden by default. Tokens are excluded.
- `wait --consumer ID [--timeout-ms N] [--lease-ms N] [--limit N] [--poll-ms N]`: claim due work or report timeout. Timeout defaults to 30000 (0–60000), lease to 60000 (50–3600000), limit to 10 (1–100), poll to 100 (20–1000). Result: `batch`, `timed_out`, `waited_ms`, and a timeout `reason` when applicable. Each item includes its `token` and `mode` (`execute`, `reconcile`, `ack`).
- `next-batch --consumer ID [--lease-ms N] [--limit N]`: one immediate attempt; busy/empty returns an empty batch with a reason.
- `begin REQUEST_ID --token TOKEN`: persist execution intent. Invoke a new external action only when `proceed: true`; repeated intent returns `proceed: false` and its recovery mode.
- `renew REQUEST_ID --token TOKEN [--lease-ms N]`: extend a still-valid lease. Renewal does not grant another execution attempt.
- `record REQUEST_ID --token TOKEN --source SOURCE --run-id REAL_REFERENCE --state STATE --evidence TEXT [--observed-at TIMESTAMP] [--source-version N] [--outcome pass|fail]`: atomically record actual task execution evidence and an idempotent receipt. `--outcome` is required only for verification; `check_id: null` means a superseded check was not applied to the current work. Use the source's actual monotonic version when available; do not invent it.
- `ack REQUEST_ID --token TOKEN`: acknowledge a recorded result; repeat with the same successful token safely.
- `nack REQUEST_ID --token TOKEN --error-code handler-failed|tool-unavailable|permission-denied|environment-failed|rate-limited|lease-expired [--retry-after-ms N]`: retry with a bounded budget, retaining intent/result. Explicit delay range 0–86400000; default backoff 1–60 seconds.
- `resolve REQUEST_ID --token TOKEN --evidence TEXT`: only after authoritative proof no external execution started and no old worker can still act; clear the intent into the normal retry/dead path and retain evidence.
- `reschedule REQUEST_ID --reason TEXT`: explicitly renew an exhausted/released request's attempt budget; existing intent stays in reconciliation mode. Changed work requires a new request. Not an automatic retry loop.
- `unschedule REQUEST_ID --reason TEXT`: cancel unstarted work without a live lease. Existing execution intents must first be reconciled and acknowledged.

The consumer must continue waiting/reading a yielded tool process before rearming.
Scheduling commands do not spawn a daemon, run arbitrary shell text, send a message, or call a
platform API. Explicit integration policies permit `deliver`/`start` to send queued notifications. Defaults can be shortened for isolated tests; practical tool work
usually needs a longer lease and small batches.

## Message integration commands

Read [connectors.md](connectors.md) before configuring a transport or starting its consumer. All configuration IDs are immutable except their enabled status. Defaults never select a recipient.

- `connect --id ID --module ABSOLUTE_PATH --settings-file JSON_FILE`: verify protocol/capabilities, pin adapter entry hash and nonsecret settings; identical registration reuses the binding.
- `connections` / `disconnect ID`: inspect bindings or disable one.
- `handshake-begin --id SETUP_ID --connector ID --account APP_ID --brand feishu|lark --authorization-ref TRUSTED_DOT_MESSAGE_REF --grant-id ID --commands query,create,continue --tasks none|all|ID,ID [--allow-new] [--updates] [--watch-id ID --initial] [--tenant EXPECTED] [--sender EXPECTED] [--destination EXPECTED] [--ttl-ms N] [--format card|markdown|text] [--reply-mode reply|send] [--language en|zh]`: preregister an already authorized first private-chat scope. Defaults: 600000 ms lifetime (range 1000–1800000), card, reply, zh. Returns the exact `dot-bind:<64 lowercase hex characters>` challenge once; only its hash is persisted in task setup state. Reuse verified bindings; disabled/conflicting policies fail closed. See [handshake validation and recovery](connectors.md#first-identity-handshake).
- `handshake-status SETUP_ID`: inspect persisted setup/evidence without revealing the challenge; status inspection does not consume inbox messages or prove send acceptance.
- `handshake-cancel SETUP_ID`: cancel pending setup; do not use cancellation to revoke a consumed grant/watch or retry an uncertain notification. Inspect and use the existing explicit grant/watch controls for those actions.
- `watch --id ID --connector ID --account ID --destination ID --tasks all|ID,ID [--events EVENT,EVENT] [--destination-type chat_id] [--format card|markdown|text] [--language en|zh] [--initial]`: authorize matching outbound snapshots; format defaults to card, language to zh, events to completed. Other explicit event subscriptions are retained for compatibility; this completion-only workflow must not enable them. Events: registered, progress, blocked, failed, completed, verification, result, execution. `--initial` applies only to first creation.
- `unwatch ID`: disable a subscription; pending entries cancel on next claim.
- `allow-inbound --id ID --connector ID --account ID --tenant ID --sender ID --destination ID --mode agent --commands query,create,continue --tasks all|ID,ID|none [--allow-new] [--updates] [--since ISO_TIMESTAMP] [--format card|markdown|text] [--reply-mode reply|send] [--language en|zh]`: explicitly enable ordinary text/post agent review for this identity and scope. The create class and `--allow-new` must be enabled together; `--updates` separately permits completion for associated tasks. Both flags default false. Default since is now, format card, reply mode reply; new replies request threads. Omitted agent language displays Chinese without adding a field to old grants. Re-registration retains the original cutoff; policy IDs are immutable.
- `allow-inbound ... [--mode commands] --commands list,show,run,verify --tasks all|ID,ID ...`: legacy exact-command mode, also the default when mode is omitted. Run/verify-only grants need durable receive but no outbound capability; list/show additionally need the selected response method and format. Agent-mode grants, including updates, need their selected response method/format. Reply-mode updates use the latest create/continue message as a reply anchor and do not additionally need send support.
- `message-next --consumer ID [--limit N] [--lease-ms N]`: claim pending agent-intake messages with tokens, scoped task/conversation context and interpret/ack recovery mode. Default limit is 1 (maximum 20), lease 60000 ms (maximum 3600000); values must be positive integers. The returned `source` is `connector-` plus connector ID and `source_ref` is the scoped message `id`. Reuse both when scheduling. Context caps task summaries at 50 and recent messages/reply references at 20; direct reply/inbound matches include older scoped references (up to 20 each). Inspect `task_coverage` and `reference_coverage`; missing references are not automatic most-recent-task selection. Does not classify text or execute work.
- `message-renew ID --token TOKEN [--lease-ms N]`: renew a current intake lease before expiry; default 60000 ms, positive integer up to 3600000.
- `message-record ID --token TOKEN --decision-file JSON_FILE`: atomically record a reviewed decision, its create/link effect and scoped reply. Required fields: `decision`, bounded single-line `summary`, and exactly one of legacy single-line `reply` or structured `response`. The decision file is at most 64 KiB UTF-8; `response` is at most 24 KiB. The [five response templates](reply-presentations.md) preserve multiline plain content and support a reviewed per-message format override without changing the route or grant. Decisions are query/clarify/reject/create/continue. Query permits a scoped `task_id` and binds the message source when supplied; create requires `title`, `goal`, `next_action`, `authorization_ref`; continue requires scoped `task_id`, `work_revision`, `authorization_ref`. No scheduling or platform execution occurs. See [decision and recovery rules](connectors.md#agent-decisions-and-recovery).
- `message-ack ID --token TOKEN`: acknowledge a recorded intake decision only after dot has durably scheduled any authorized create/continue work. Recovery in ack mode must reconcile that same schedule first. Not a scheduler acknowledgement or proof of task completion.
- `deny-inbound ID`: disable a grant.
- `ingest --connector ID [--limit N]`: process one durable page (default 100, 1–1000); return ingested count and has_more. Pending identity handshakes are checked before normal grants; with neither an eligible pending setup nor enabled grants, read nothing.
- `inbound`: inspect checkpoints and scoped accepted/rejected outcomes without raw message text.
- `outbox [--all]`: inspect notification IDs, routes, states, attempts and safe receipts; default hides API-accepted/cancelled entries.
- `deliver --consumer ID [--limit N] [--lease-ms N]`: deliver up to N entries (default 10, 1–100); default lease 120000 ms (1–3600000). Too-short leases can leave delivery unknown.
- `resolve-notice ID --status api_accepted|not_sent --evidence TEXT [--message-id REAL_ID]`: reconcile an unknown delivery only from authoritative evidence; accepted requires message ID.
- `retry-notice ID --reason TEXT`: explicitly renew a dead/API-error notice's budget using the frozen route/body/key. Unknown delivery must be resolved first.
- `start [--consumer dot-active] [--timeout-ms 30000] [--lease-ms N] [--limit N]`: initialize/reuse local store, ingest pending handshakes and permitted inboxes, deliver outbox, return claimed agent `messages` alongside scheduled `batch` work. Idle wait budget 0–60000 ms; bounded connector work adds time. Return scheduler fields plus messages, ingested, notifications, receive_gaps and non-attesting readiness. Repeat actively after both message and scheduling processing/acknowledgement; no daemon is created.

## Per-task conversation commands

Read [task-conversations.md](task-conversations.md) for authorization, payloads, identity validation, original-root correlation, privacy review, question revisions, and uncertain-send recovery. These commands do not activate a receiver, migrate grants, intercept platform tools, or execute answers. Existing notification defaults remain completion-only.

- `conversation-bind TASK_ID --file JSON_FILE`: explicitly bind immutable, verified dot/Feishu endpoints and the authorized channel subset. Requires actual authorization, an existing recorded/done task-associated inbox ID as `verification_ref`, its original topic root, and a currently scoped Feishu grant. Settle matching legacy replies before binding.
- `conversation-show TASK_ID`: inspect the binding, canonical messages, questions, deliveries, and receipts before retry or recovery.
- `conversation-disable TASK_ID`: stop further dispatch without rewriting accepted or uncertain external effects.
- `conversation-publish TASK_ID --file JSON_FILE`: durably record one reviewed shared `text`, `question`, `question_update`, `blocked`, or `completed` message and its authorized deliveries. Reuse stable origin IDs for identical retries. Optional semantic `response` must have `lead` equal to canonical `text`, with no `format_override`. Completed messages require a completed task; normal `complete` automatically queues its canonical result.
- `conversation-input TASK_ID --file JSON_FILE`: append reviewed verified user text to the task's shared backend history with zero outbound deliveries. User text stays on its originating endpoint; only assistant replies fan out. Requires exact identity, topic correlation, source timestamp, and `evidence_ref`; Feishu requires its matching stored inbox record. Question references are optional. Distinct provider messages always append, even when identical or contradictory; only unchanged retries of the same origin deduplicate.
- `conversation-answer TASK_ID --file JSON_FILE`: the same append workflow with required contextual `question_id`/`question_revision` and an accepted question delivery in that channel. References are not votes, first-answer selection, or automatic approval.
- `conversation-next --channel dot|feishu --consumer ID [--lease-ms N]`: claim one channel's pending delivery, or return `null`. Lease defaults to 120000 ms, range 1–3600000. Preserve its returned identity and fencing token; use `delivery_text` for the full plain-text dot message. Use `conversation-show` for stopped/uncertain delivery recovery.
- `conversation-begin DELIVERY_ID --token TOKEN`: persist intent before the actual send. Only `proceed: true` permits a new external attempt.
- `conversation-receipt DELIVERY_ID --token TOKEN --file JSON_FILE`: record the actual normalized connector send result, including the real provider ID and thread references when available.
- `conversation-resolve DELIVERY_ID --file JSON_FILE`: resolve a stopped delivery with `status: api_accepted|not_sent` and conclusive `evidence`; accepted also requires the real `message_id`. A no-send resolution requeues the same delivery. Never retry a possibly sent message with a fresh ID.
- `conversation-deliver --consumer ID [--lease-ms N] [--limit N]`: dispatch eligible Feishu entries through their pinned adapter. Defaults: lease 120000 ms (1–3600000), limit 10 (1–100). Dot delivery remains an active assistant tool action.
- `conversation-consume TASK_ID --file JSON_FILE`: an optional referenced-question action-context guard using current `expected_revision`, latest question `expected_answer_id`, and latest task-wide `expected_input_id`, plus actual `authorization_ref` and stable `action_ref`. New input invalidates stale context and requires rereading; prior action IDs reconcile instead of rerunning. It never interprets approval or executes the action. Consumption history is append-only.

For conversation JSON, `privacy: "reviewed"` is the caller's attestation, not a content detector or permission grant. Native approval widgets, secure handoffs, secrets, and unrelated private logs are excluded. Apply actual platform/action permissions within the normal task workflow; a context guard does not grant approval.

For a bound task or exact bound topic, `message-record` requires the incoming message to be recorded with `conversation-input` first, then `canonical_message_id` pointing to a later published matching assistant text/response and suppresses a second legacy reply. Claims expose `context.task_conversation`; exact-topic intake suppresses the old automatic receipt acknowledgement. `start` also dispatches canonical Feishu deliveries and returns at most one dot claim in `conversation_deliveries.dot`; process its returned token through begin/tool/receipt. Standalone `deliver` remains legacy-only. Verified `complete` queues one canonical result and suppresses duplicate legacy notices only on the matching connector/account/chat route; independent routes retain their policies. See the [integrated intake mechanics](task-conversations.md#integrate-with-the-active-intake-loop).

`start.conversation_issues` exposes a bounded set of stopped/uncertain canonical deliveries after recovery. Inspect and reconcile original attempts without repeated warning messages or a tight retry loop. List/detail notification summaries include canonical delivery state, including unresolved delivery on completed tasks.

## Blockers and recovery

```bash
taskctl update task-release --status blocked --reason "Access unavailable" --blocker "Cannot open the delivery link" --next-action "Restore access and check again"
taskctl event task-release --kind blocker --text "Confirmed access failure" --source "Actual link access attempt"
taskctl update task-release --status executing --reason "Access restored" --blocker "" --next-action "Repeat acceptance checks"
```

`event --kind blocker` adds history; it does not set the current blocker. Use `update --blocker` and an appropriate status for a current blocker. Clearing it with `--blocker ""` requires leaving `blocked`. Reopen completed work with `update ID --status executing --reason TEXT` before material changes.

## Observe execution

Execution states are `unknown`, `queued`, `inProgress`, `completed`, `failed`, `interrupted`, and `disconnected`.

```bash
taskctl observe task-release --state inProgress --source "Current platform task query" --run-id "RETURNED_TASK_ID"
taskctl observe task-release --state completed --source "Actual turn result"
```

The second command does not mark the user task complete. Inspect results, perform acceptance checks, and record them separately. An observation does not prove continued availability. A disconnected execution may be recorded as `disconnected`; task-level blocking depends on whether it still prevents progress.

Timestamps are timezone-aware ISO 8601 values and default to the current time. Future observations, regressing execution observations or source versions, and checks predating the latest task update are rejected by `observe`/`check`. Scheduled receipts preserve delayed facts in history without overwriting a newer execution snapshot. A monotonic `source-version` is scoped to one source and execution reference; keep supplying it once that reference has versioned observations. Describe historical evidence as an event rather than presenting it as a fresh check.

## Concise views and delivery

`--summary` holds one or two current facts. Retain detailed blockers and evidence in their own fields. Detail views preserve the complete current blocker and all current failed checks. Existing records without `summary` remain readable.

Filtering affects presentation only. Reading and rendering do not update task activity. The completion column uses `completion.at`, not the latest activity time. Use `list --all` for deduplication or auditing.

Use `render bundle` for navigation between generated files. Individual `--output` commands generate only the selected view. Outputs must be outside the authoritative store. Verify audience access before sharing; the renderer never accesses the network. Notifications belong to a separate, explicitly authorized capability.

## Portability and verification

Node.js 22.18.0+ uses the same commands on Linux and macOS. There are no Python, npm, or system `flock` runtime dependencies. Existing schema-1 records and history remain readable. Read-only commands preserve legacy projection bytes; a later authorized mutation regenerates that task's projections with English headings. The record's user text and historical events are preserved. Stop old writers before switching implementations; incompatible locking schemes cannot safely share a store.

Run `node --test "$SKILL_DIR/tests/"*.test.mjs` for automated local tests. Review [../tests/first-use-scenarios.md](../tests/first-use-scenarios.md) and [../tests/scheduling-scenarios.md](../tests/scheduling-scenarios.md) separately for simulated assistant decisions; real execution and memory persistence must be checked in the target runtime.

Package with `node "$SKILL_DIR/scripts/package.mjs" /absolute/output/manage-dot-tasks.zip`. The ZIP contains skill code, templates, instructions, and synthetic test data only. It does not include real task stores, webhook credentials, notification adapters, or a platform memory implementation.

`message-fail ID --token TOKEN --stage parse|create --reason TEXT` records an unrecoverable authorized request failure after reconciliation proves no task/decision was committed. Reasons must be sanitized single-line text (at most 1,000 characters). The same token/reason is idempotent; recorded decisions cannot be replaced with failure. It queues a scoped failure response and makes the uncreated request visible in the list.

`request-failure ID --stage parse|create --reason TEXT --evidence TEXT` annotates an existing historical rejection after the active agent verifies its identity/failure from authorized evidence. It requires no committed task binding, preserves the rejected record and dedup, and never replies or replays. The annotation is immutable/idempotent and appears in the failed-request section. Do not infer ownership from a hash or use this to relabel uncertain external effects.

For an authorized adapter upgrade, `allow-inbound --mode agent --context-from OLD_GRANT_ID[,OLDER_GRANT_ID]` explicitly preserves only old task-bound reference evidence for the exact same account/tenant/sender/destination and the new grant's current task scope. Maximum 20 explicit old agent grant IDs; no transitive inheritance, old input replay or policy reactivation. See [safe migration](migration-threaded-intake.md).
