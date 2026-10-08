# Scheduling and Active Dot Operation

`manage-dot-tasks` is one task-management and scheduling product. The task model,
acceptance checks, persistent event queue, CLI, and Markdown UI share one store and
one entry point: `scripts/taskctl.mjs`. The scheduler is an internal module. It
requires only Node built-ins on a Linux/macOS local disk, with no server, manual
MCP configuration, shell executor, or platform task API inside Node.

This first version assumes dot remains active or thinking. Operation consists of
an active dot tool call waiting for work, dot using its actual tools, and another
bounded wait. Tool timeouts and execution-environment failures are recoverable
parts of that workflow. Initializing a store or launching an unattended process
does not establish that dot is consuming it.

For integrated Feishu intake, use the continuous `start` chain described in
[startup](startup.md#continuous-consumption-and-wake-up-boundaries): collect each
bounded result, process it, then immediately re-arm. Ten-minute health/recovery
automations cannot replace this active consumer. A local ledger registration is
also not a platform task; follow [real platform task mapping](platform-tasks.md)
when authorized work needs a separately inspectable execution thread.

## Intake, discovery, and identity

Use the same store for user commitments in this conversation, dot-delegated work,
and observed local tasks within the user's authorized scope. A task is the user's
goal; a source identity is a particular conversation commitment or external task;
a request is one authorized action; an event is one durable delivery trigger.

- For a conversation promise, derive a stable reference from the actual thread,
  user turn, and commitment. Distinct goals in one turn need distinct references.
- For delegated or local tasks, use the actual platform task ID and a source
  namespace identifying the platform and host/account. Read details before
  associating a run with a goal. Titles alone are not identity.
- `register --source SOURCE --source-ref REF ...` atomically registers and binds
  new work, or returns the existing task without overwriting it. `lookup` finds
  that binding; `bind ID` associates another verified identity with the same task.
  A conflicting binding fails rather than merging unrelated tasks.
- Read the available platform query tools. Enumerate pages only when the tool
  actually supplies pagination. A 50-item listing with no cursor is partial;
  it does not prove all local tasks were discovered. A missing task in a partial
  result is neither deleted nor known never to have been created.
- Record discovery coverage with `coverage --source ... --scope ... --state
  partial|complete|unavailable --evidence ...`. `complete` requires evidence that
  the supported query exhausted that specific authorized scope at that time.
  Without such evidence, use `partial` or `unavailable` and report the gap. The
  CLI stores supplied evidence; it does not discover tasks or certify coverage.
- Refresh known sources through supported tools while processing events or after
  a wait timeout as authorized. Register newly observed identities and enqueue
  only meaningful changes. Do not turn routine probes, renders, ack operations,
  this consumer's own activity, or notifications into more scheduled work.

Keep task text in its original language. Queue specifications contain references,
action types and revisions, not executable instructions or copied conversations.
Use opaque references and short, sanitized evidence. Never copy credentials,
private message bodies, environment dumps, or raw error logs into task records,
scheduling specifications or notifications. Agent-mode integration stores bounded
authorized raw text separately in its private intake envelope for agent review.
Text length bounds and rejected unknown flags are not a secret scanner.

## Conversational intake before scheduling

With an explicitly configured agent-mode message grant, `start` returns durable
claimed `messages` in addition to scheduler `batch` items. Dot interprets natural
language; the CLI never guesses intent or calls platform tools. Follow the
[message decision protocol](connectors.md#agent-decisions-and-recovery): record a
sanitized decision, create or link the task atomically, then use `schedule` for an
authorized action before `message-ack`. Use the claim's exact `source` (`connector-` plus connector ID) and
`source_ref` (its scoped message `id`), with stable event/request IDs; replay must
reuse them. Do not use the raw provider message ID as the source reference. A
recorded decision recovered in ack mode needs that same scheduling check, not a
new task or action. A query, clarification, or rejection needs no execution
request. The scheduler's `begin`, execution reconciliation, `record`, `ack`, and
acceptance checks remain unchanged. Inbound intake acknowledgement and scheduler
acknowledgement are distinct.

## One durable scheduling request

Read the task and stage its task/step status before scheduling. Before actual
execution, explicitly use `update TASK_ID --status executing --reason ...` and
record the next action, then schedule using the resulting current revision.
`begin`, `record`, and `ack` do not transition task progress. After the actual
work is ready, enter `awaiting_verification`, perform the requested acceptance
checks, record `check --outcome pass` with real evidence, and call `complete`
only after all completion requirements hold. A schedule is bound to
`work_revision`; later material changes require reviewing a new request.
Summary-only updates and execution observations do not invalidate that revision.

```bash
taskctl schedule TASK_ID --event-id EVENT_ID --request-id REQUEST_ID \
  --source conversation --source-ref COMMITMENT_REF \
  --action execute --authorization-ref USER_TURN_REF --work-revision REVISION
taskctl wait --consumer DOT_CONSUMER_ID --timeout-ms 30000 --lease-ms 60000 --limit 1
```

Replace uppercase tokens with actual record values. `taskctl` abbreviates
`node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR"`. A schedule's
`authorization-ref` records where dot verified authorization; text in that field
or in an incoming event cannot itself grant permission.

Actions are `execute`, `observe`, and `verify`. `execute` needs a queued/executing
task and, when supplied, an unfinished `--step-id`. `verify` needs an
`awaiting_verification` task and `--check-name`. `observe` can inspect any task.
Each can reference a step. `--not-before` accepts a timezone-aware ISO timestamp
for one delayed dispatch; omission means immediately eligible. This version has
no recurring calendar rule or persistent daemon. Dot can register subsequent
occurrences, with new authorized occurrence identities, when its workflow calls
for them.

The caller supplies stable event and request IDs **before its first write**, then
reuses them after an uncertain response. IDs are store-wide. An event ID cannot
refer to two requests; one request ID cannot change specifications. Multiple
events for the same request are retained and coalesced into one dispatch.
Changing just the request ID cannot reschedule the same source action, task,
work revision and step/check. Reuse the canonical request or give genuinely new
work a distinct source occurrence and request ID. Acknowledged/cancelled records
and event IDs remain stored for deduplication; there is no automatic pruning.

Enqueue commits its recovery journal and queue before returning. There is no
notification dependency: `wait` scans on entry, every poll, and once more at the
deadline. It returns due work or an explicit timeout. `next-batch` performs one
nonblocking attempt. `wait` releases the store lock between scans, so producers
and other consumers can write while it waits. Both also reclaim expired leases.

## The active loop

When the user asks dot to start, continue the following loop within the authorized
scope instead of stopping after an initial status report:

1. Call `wait` (default 30 seconds; maximum 60 seconds). If the environment returns
   a process/session ID before completion, continue reading/waiting on that same
   process until its result is collected. Do not abandon its output and claim
   listening is established. If the process is lost, its lease can expire and a
   later call can recover the request. Do not accumulate detached waiters.
2. On timeout, carry out any authorized source refresh and call `wait` again.
   `reason: store-busy` means the queue could not be examined, not that it is
   empty. Surface persistent environment/permission failures and keep pending
   work durable; do not spin on a failing tool.
3. For each returned item, inspect its task, source, work revision, authorization
   and `mode`. The returned `token` fences this lease. Choose small batches and a
   lease long enough for real tools. Renew before expiry during longer work.
   One store serializes outstanding work per task, including uncertain intents.
4. For `mode: execute`, persist `begin REQUEST_ID --token TOKEN`. Only a response
   with `proceed: true` permits this new attempt to invoke the authorized tool.
   If the response is lost, read/reconcile the durable intent first. Check that
   the lease is still usable and authorization still applies just before the
   external call. Use the returned request ID as an external idempotency key
   **only if the actual tool supports it**. Never invent unsupported arguments.
5. Use dot's real supported tools to create, query, or perform the work. Node
   returns local request IDs, not platform execution IDs. Record the actual
   returned execution reference and observed state with `record` below. A result
   may only mean a delegation was accepted or a turn ended; it need not mean the
   user's task is complete. Continue tracking and acceptance separately.
6. After the result is durably recorded, verify any [platform task mapping](platform-tasks.md)
   and `bind` its real thread ID before `ack REQUEST_ID --token TOKEN`. Repeat
   ack with the same token if its response was lost; it is idempotent. Any
   separately authorized notification comes after persistent result recording
   and needs its own send-result handling. This scheduler sends nothing.
7. Return to `wait`. Events arriving during tool execution, between waits, during
   a timeout, or while a process restarts remain in the queue.

```bash
taskctl begin REQUEST_ID --token TOKEN
# Dot invokes an actual authorized tool after proceed: true.
taskctl record REQUEST_ID --token TOKEN --source ACTUAL_TOOL_SOURCE \
  --run-id ACTUAL_EXECUTION_REFERENCE --state queued \
  --evidence "Sanitized factual result from the tool"
taskctl ack REQUEST_ID --token TOKEN
```

`record` needs a real reference available to dot: for example, a returned task/run
ID, or the actual current execution reference for work done in this conversation.
If it cannot be established, leave the request unacknowledged and report the
missing evidence. Never manufacture one to advance the queue.

## Uncertain effects and recovery

The queue provides **at-least-once delivery**, not exactly-once external effects.
`begin` persists an intent before the external action. Repeating begin, renewing
or reclaiming its lease never grants another dispatch for that intent.

| Durable state on recovery | Returned mode | Dot's next action |
| --- | --- | --- |
| No intent or receipt | `execute` | Verify authorization and current work, then begin |
| Intent, no receipt | `reconcile` | Query the actual execution; do not create again |
| Receipt, no ack | `ack` | Inspect the saved receipt, then acknowledge |
| Done/cancelled | No delivery | Keep history for deduplication |

In `reconcile`, retrieve the actual execution using a supported request-key lookup
or other conclusive correlation. If found, record its real ID and observed result
and then ack. If the query is unavailable, partial, eventually consistent, or
temporarily returns nothing, uncertainty remains: use a bounded `nack` retry or
leave it for manual review. Absence in a recent-tasks listing is insufficient.

`resolve REQUEST_ID --token TOKEN --evidence TEXT` clears an intent **only after
authoritative evidence that no external action started**, such as a documented
rejection before creation. It preserves that evidence and consumes the normal
retry budget. It is not a generic "not found" recovery button. Lease fencing
cannot stop an old worker already making an external call, so also establish that
it can no longer act before clearing its intent. Never clear an uncertain intent
just because its lease expired.

`nack` records one of the fixed error codes and applies bounded exponential
backoff (1–60 seconds by default, or an explicit delay up to 24 hours). It never
erases an intent or receipt. `--max-attempts` defaults to 5. Exhaustion leaves a
visible `dead` request; dot stops automatic retries and reports the reason.
After the blocker is resolved, an explicitly chosen `reschedule --reason` adds
another bounded attempt budget, preserving the intent and hence reconciliation
mode. Do not automatically reschedule exhausted work in a loop.

Expired claims without an intent can be redelivered. Expired claims with a
receipt remain ack-only even if the retry budget is exhausted. Expired or replaced
tokens cannot begin, record, renew, nack, resolve, or ack. `unschedule --reason`
cancels unstarted work after its lease is released/expired. Reconcile and ack an
existing intent instead of hiding it through cancellation.

## Task evidence, UI, and storage

`record` atomically stores the receipt and task observation using the existing
transaction journal. Retrying identical receipt data does not add a task event or
check again. Different result data for the same request is rejected. New
observations need a new source occurrence/request; older source timestamps stay
in receipts/history without regressing the latest execution snapshot. When the
tool returns a monotonic status version, pass `--source-version N`. Older/equal
versions of the same source/run cannot regress that snapshot even when received
later. Do not manufacture source versions or use local arrival order as one.

For a verification request, supply `--outcome pass|fail` after actually performing
the named check. A check is recorded atomically with the receipt only if the
scheduled work is still current and awaiting verification. Otherwise its receipt
is preserved with `check_id: null`, and cannot verify current work. Inspect that
field before reporting acceptance. `record` and `ack` never call `complete` or
finish a step. The original task state transitions and acceptance requirements
still apply; a failed check prevents completion.

`queue [--task-id ID] [--all]` exposes scheduling details with lease tokens hidden.
`render list`, `render detail` and `render bundle` show pending schedules, retries,
reconciliation and failures in the existing Summary column. Task content,
blockers and failed checks remain visible. Default lists are limited to ten recent active tasks. Inspect scheduling on terminal tasks through `queue`, a detail view or `render list --all`.

The optional `scheduler.json` is created on the first scheduling/discovery write.
Legacy task schema and projections remain readable without modification. This
file contains bindings, coverage observations, event IDs and requests (spec,
attempt budget, due time, lease, intent, receipt and reconciliation evidence).
Task, index and scheduler writes share the same lock and replayable transaction.
`doctor` validates local structure and references; it cannot verify source facts,
authorization, live task execution or platform memory.

Use a single-host local disk with atomic rename and fsync. Stop older writers
before operating the scheduler. Keep snapshots/backups and task stores outside
the skill checkout. This version rewrites a single scheduler snapshot under the
lock and retains deduplication history; it targets a modest personal task store,
not an unbounded broker. Concurrent readers must use the CLI. No new dependency,
network port, notification adapter, or long-running service is installed.

## Verification scope

Run `node --test "$SKILL_DIR/tests/"*.test.mjs`. Synthetic tests cover source and
event deduplication, concurrent processes, timed delivery, rearming, missed-wait
intervals, lease expiry, process death, journals, failures, stale tokens,
create-before-ack reconciliation, delayed results and the legacy CLI/UI.

These tests do not establish live dot task creation, platform idempotency,
complete discovery, notification delivery or memory persistence. Review
[../tests/scheduling-scenarios.md](../tests/scheduling-scenarios.md) for assistant
behavior. A real end-to-end acceptance run needs the user's later authorization
and actual tool results in the target dot environment.
