# Real platform task mapping

Read this when authorized Feishu intake requests work that needs a real,
inspectable platform task. `register`, `message-record` and `schedule` write the
local ledger only. They do not create a desktop task, start an execution thread,
or prove that a card is visible in the app. Node must never simulate a platform
API or manufacture a thread ID to advance the queue.

## Choose the work and execution environment

- Answer simple questions from verified facts in the original chat; no execution
  task is needed solely to reply. Clarification and rejection also need no task.
- For an authorized new task, the agent invokes actual `cloud_threads.create`.
  Query and continue real tasks with `cloud_threads.read` and
  `cloud_threads.send_message`. Read the available tool schemas and use supported
  arguments; these names describe agent tools, not Node functions to implement.
- Use actual platform automation tools for scheduled or recurring requests.
  Registering a ledger request or starting a thread now does not establish a
  future platform invocation. Preserve the saved automation's real ID and scope.
- Preserve the user's selected task environment independently of the Feishu
  receiver host. Reuse the selected local computer or cloud environment. Never
  migrate work, select another host, or duplicate a task merely to show a desktop
  card. If the selected environment/tool is unavailable, report that blocker.

Carry the originating connector, account, tenant, sender, chat, provider message
and topic references from the verified intake envelope. Preserve the claim's
exact `source` and `source_ref` for ledger scheduling and the recorded grant and
action authorization. A platform mapping adds another source binding; it does
not replace Feishu provenance or widen the task's permissions. Send only the
reviewed task goal, necessary context, acceptance criteria and authorized action
scope to the execution thread, not credentials or unrelated conversation data.

## Create, record and bind

Follow the [message decision protocol](connectors.md#agent-decisions-and-recovery)
and [scheduler contract](scheduling.md) first: record the decision, stage task
progress, schedule with stable event/request IDs and the current work revision,
then acknowledge intake. Before dispatch, inspect existing source bindings,
task execution evidence and the scheduler receipt. Reuse a verified task mapping
instead of creating a second thread. Titles and recent activity are not identity.

For a new authorized execution, use this durable sequence:

1. `begin REQUEST_ID --token TOKEN`. Only `proceed: true` permits a new tool
   effect. Recheck the actual authorization and selected environment.
2. Invoke the actual `cloud_threads.create` tool. Keep its result and real
   `threadId`; query it with `cloud_threads.read` when needed to establish its
   identity, environment and current state. If creation is still pending, collect
   its supported result before treating a provisional operation ID as a thread.
3. `record` the real returned `threadId` as the execution `--run-id`, with the
   verified platform/host source namespace, observed state and sanitized evidence.
4. `bind TASK_ID --source PLATFORM_SOURCE --source-ref THREAD_ID` to associate
   that exact thread with the existing ledger task. Verify with `lookup`.
5. Only after the receipt and mapping are durable, `ack REQUEST_ID --token TOKEN`.

For example, after an actual tool returns a confirmed thread ID and queued state:

```bash
taskctl begin REQUEST_ID --token TOKEN
# The active agent now calls the actual create/read tools and collects results.
taskctl record REQUEST_ID --token TOKEN --source PLATFORM_SOURCE \
  --run-id THREAD_ID --state queued --evidence "Verified task creation receipt"
taskctl bind TASK_ID --source PLATFORM_SOURCE --source-ref THREAD_ID
taskctl lookup --source PLATFORM_SOURCE --source-ref THREAD_ID
taskctl ack REQUEST_ID --token TOKEN
```

`taskctl` abbreviates `node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR"`.
Replace the uppercase tokens with actual values. The platform source must
identify the verified platform and host/account consistently. Do not invent
idempotency arguments for tools that do not support them. `bind` here is the
scheduler's source mapping, not `conversation-bind` and not an additional grant
to fan out messages.

## Recover and continue the same task

If creation may have happened but no result was recorded, keep the original
intent and reconcile through actual tool results or conclusive platform
correlation before any new create call. A missing result in a bounded recent
list, timeout, expired lease or unavailable query is not proof of non-creation.
Never change request IDs to bypass this uncertainty. Leave uncertain work
visible using the existing bounded recovery flow; do not mark it uncreated.

If `record` succeeded before interruption, use its saved real thread ID. Verify
and complete any missing `bind` before the ack-only recovery step; never create
again. A conflicting binding is a blocker, not permission to overwrite it.

For later status or continuation requests, resolve the same scoped mapping and
read that actual thread. Send an authorized follow-up with
`cloud_threads.send_message` to the same `threadId`, preserving the chosen
environment and current task scope. New tool effects still use `begin → actual
tool → record → verify binding → ack`. Reconcile an uncertain follow-up receipt
before repeating it, just as with creation. Renew leases for longer operations.

## Progress, acceptance and reporting

Read progress, blockers and conclusions from the actual platform task with
`cloud_threads.read`, then record an observation/result in the ledger. Do not
infer live progress from local status labels or a stale card. A platform turn
ending is not acceptance of the user's goal: enter `awaiting_verification`,
check the requested deliverable, record current passing checks and only then
call `complete`. Reuse the same task for necessary authorized follow-up work.

Return verified progress or conclusions to the original Feishu chat only within
the recorded reply/update authorization, using its original message/topic and
the existing delivery protocol. Preserve completion-only proactive defaults;
explicit status questions may receive a scoped answer. Unknown notification
delivery keeps its original attempt and key and never triggers a blind resend.

Report platform creation and desktop visibility separately. A verified create
receipt supports “task created” with its real reference/link. Say that the task
is displayed in the desktop UI only after actual UI or platform evidence shows
it there; otherwise state that visibility is unverified. Neither a ledger ID
nor a rendered Markdown row establishes that UI outcome.
