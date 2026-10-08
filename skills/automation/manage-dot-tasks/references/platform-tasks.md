# Execution location and real task mapping

Read this before dispatching authorized Feishu task work or choosing its
execution environment. Default all work to dot's actual tools and execution
capabilities, including research, multi-step work, delegation and scheduled
work. A local computer or another supported execution environment is an
exception only when the user explicitly selects it.

`register`, `message-record` and `schedule` write the local ledger only. They do
not create a desktop task, start an execution thread, or prove that a card is
visible in the app. UI visibility and execution location are separate facts.
Node must never simulate a platform API or manufacture an execution reference.

## Choose the work and execution environment

- Answer simple questions from verified facts in the original chat; no new
  thread is needed solely to reply. Clarification and rejection also need no task.
- Execute authorized work in dot by default. Research, multiple steps or
  delegation do not change that default. Use dot's actual execution and
  delegation capabilities within the user's scope; do not use
  `cloud_threads.create` as the default new-task entry point.
- Only when the user explicitly selects a local computer or another supported
  execution environment, use the corresponding actual `cloud_threads.create`,
  `cloud_threads.read` and `cloud_threads.send_message` tools for that route.
  Read the available schemas and use supported arguments; these are agent tools,
  not Node functions to implement. Mere availability or an online desktop does
  not select that route or authorize a local fallback.
- Use actual platform automation tools for scheduled or recurring requests in
  dot by default. Preserve the saved automation's real ID, execution environment
  and scope. A ledger schedule or immediate thread creation does not establish
  a future platform invocation. Scheduling is not an exception to the dot default.
- Keep the executor independent of the Feishu receiver host and configuration
  source. A local receiver or bridge worker authorizes its transport role only.
  Missing UI activity or a task card cannot authorize migration or local work.
  If an explicitly selected environment/tool is unavailable, report the blocker
  without changing locations. If dot's required capability is unavailable,
  report that limitation rather than falling back to the desktop.

Carry the originating connector, account, tenant, sender, chat, provider message
and topic references from the verified intake envelope. Preserve the claim's
exact `source` and `source_ref` for ledger scheduling and the recorded grant and
action authorization. A platform mapping adds another source binding; it does
not replace Feishu provenance or widen the task's permissions. Pass only the
reviewed task goal, necessary context, acceptance criteria and authorized action
scope to actual execution or an explicitly selected thread, not credentials or
unrelated conversation data.

## Execute, record and acknowledge

Follow the [message decision protocol](connectors.md#agent-decisions-and-recovery)
and [scheduler contract](scheduling.md) first: record the decision, stage task
progress, schedule with stable event/request IDs and the current work revision,
then acknowledge intake. Before dispatch, inspect existing source bindings,
task execution evidence and the scheduler receipt. Reuse a verified mapping only
when its environment still matches the user's current direction. Titles and
recent activity are not identity, and an old local mapping is not permission
to ignore a later dot selection.

For a new authorized execution, use this durable sequence:

1. `begin REQUEST_ID --token TOKEN`. Only `proceed: true` permits a new tool
   effect. Recheck the actual authorization and selected environment.
2. Perform the work through dot's actual tools by default and collect the real
   result. Use the explicitly selected alternative route only when applicable;
   the conditional thread workflow is below.
3. `record` the actual execution reference as `--run-id`, with its verified
   source, observed state and sanitized evidence. For dot work, use the real
   dot run/current execution reference available from actual context or tool
   results. Do not relabel it as a `threadId`, substitute a ledger ID, or invent
   one. If no actual reference can be established, retain the intent, leave the
   request unacknowledged and report the missing evidence; creating a desktop
   task just to obtain an ID is not a remedy.
4. When an explicitly selected platform thread was actually returned, `bind`
   its real thread ID to the existing ledger task and verify with `lookup`.
   Ordinary dot execution does not require manufacturing a thread or mapping.
5. After the real result and any required mapping are durable,
   `ack REQUEST_ID --token TOKEN`.

The default dot sequence is `begin → actual execution → record → ack`:

```bash
taskctl begin REQUEST_ID --token TOKEN
# Dot performs the authorized work with its actual tools and collects results.
taskctl record REQUEST_ID --token TOKEN --source ACTUAL_EXECUTION_SOURCE \
  --run-id ACTUAL_EXECUTION_REFERENCE --state inProgress \
  --evidence "Verified execution result"
taskctl ack REQUEST_ID --token TOKEN
```

`taskctl` abbreviates `node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR"`.
Replace the uppercase tokens and example state with actual observed values.
The source must identify the verified execution platform and host/account
consistently. Do not invent idempotency arguments for tools that do not support
them.

## Explicitly selected platform threads

This branch applies only when the user explicitly selects local execution or
another supported execution environment. After `begin` permits a new effect,
invoke its actual `cloud_threads.create` tool and retain the returned real
`threadId`. Use `cloud_threads.read` to verify identity, environment and current
state. If creation is pending, collect the supported result before treating a
provisional operation ID as a thread. Record the actual thread ID and state,
then bind and verify it before scheduler acknowledgement:

```bash
taskctl bind TASK_ID --source PLATFORM_SOURCE --source-ref THREAD_ID
taskctl lookup --source PLATFORM_SOURCE --source-ref THREAD_ID
taskctl ack REQUEST_ID --token TOKEN
```

`bind` is the scheduler's source mapping, not `conversation-bind` or an
additional grant to fan out messages. This branch does not run merely because
the desktop is connected, a ledger task is registered, or no UI card is visible.

## Recover and continue the same task

If execution or an explicitly selected thread creation may have happened but
no result was recorded, keep the original intent and reconcile through actual
results or conclusive platform correlation before repeating the effect. A
missing result in a bounded recent list, timeout, expired lease or unavailable
query is not proof of non-creation. Never change request IDs to bypass this
uncertainty. Leave uncertain work visible using the existing bounded recovery
flow; do not mark it uncreated.

If `record` succeeded before interruption, use its saved actual execution
reference. For the explicit thread branch, verify and complete any missing
`bind` before ack-only recovery; never create again. A conflicting binding is
a blocker, not permission to overwrite it.

For later status or continuation requests, check current environment selection
before reusing a scoped mapping. Continue dot work with dot's actual tools and
execution evidence. If the explicit alternative selection still applies, read
the same thread and send authorized follow-up with `cloud_threads.send_message`
to its real `threadId`. Reconcile uncertain effects before repeating them and
renew leases for longer operations. Preserve `begin → actual execution → record
→ ack`, with verified binding before ack when using that thread branch.

If the user changes an old local task to dot, first stop further local dispatch
and verify the old task's actual running work, intent and receipts. Stop or
settle in-flight local work within the user's direction before resuming in dot;
if that cannot be verified safely, report the blocker rather than overlap or
duplicate work. Preserve the old mapping and history, record the reviewed
transition and real dot execution reference, and continue within current scope.
Do not keep sending to the old local thread just because its mapping exists.

## Progress, acceptance and reporting

Read progress, blockers and conclusions from dot's actual execution evidence,
or from `cloud_threads.read` for the explicitly selected thread branch, then
record an observation/result in the ledger. Do not infer live progress from
local status labels or a stale card. A platform turn ending is not acceptance
of the user's goal: enter `awaiting_verification`,
check the requested deliverable, record current passing checks and only then
call `complete`. Reuse the same task for necessary authorized follow-up work.

Return verified progress or conclusions to the original Feishu chat only within
the recorded reply/update authorization, using its original message/topic and
the existing delivery protocol. Preserve completion-only proactive defaults;
explicit status questions may receive a scoped answer. Unknown notification
delivery keeps its original attempt and key and never triggers a blind resend.

Report execution location, platform creation when applicable, and desktop
visibility separately. A verified create receipt supports “task created” with
its real reference/link; dot work can proceed without a separate desktop thread.
Say that a task is displayed in the desktop UI only after actual UI or platform
evidence shows it there; otherwise state that visibility is unverified. Neither
a ledger ID nor a rendered Markdown row establishes that UI outcome, and a
missing active item never authorizes local fallback or a duplicate task.
