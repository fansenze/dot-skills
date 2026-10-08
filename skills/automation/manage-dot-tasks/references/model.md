# Data Model, States, and Reliability

## File layout

```text
task-store/
  store.json                    # Schema, creation time, freshness threshold, note
  tasks.json                    # Lightweight id/title/status/updated_at index
  scheduler.json                # Optional durable events, requests, bindings and coverage
  integration.json              # Optional connector policies, outbox, private intake, dedup and checkpoints
  tasks/
    task-.../
      task.json                 # Authoritative task record
      goal.md                   # Readable goal projection
      steps.md                  # Readable steps and supporting evidence
      events.jsonl              # Event history projection
      verification.md           # Current and historical checks
      results.md                # Result links
```

`task.json` contains the goal, steps, blocker, next action, checks, results, execution observations, completion evidence, and events. Generated files are views, not additional sources of truth; do not edit them manually. The index stores only what is needed to locate tasks.

`last_checked_at` starts as null. Mutations update `updated_at`, but editing text is not a new status check. IDs remain stable when titles change. `revision` increments for every mutation; `work_revision` increments for material changes.

## Task states

| State | Meaning |
| --- | --- |
| `queued` | Waiting to start |
| `executing` | Work is progressing; no claim of live executor health |
| `blocked` | A current blocker is recorded |
| `awaiting_verification` | Work is ready for acceptance checks |
| `completed` | Current checks pass, steps are resolved, and completion evidence is recorded |
| `failed` | The goal was not achieved; retain the reason and results |
| `cancelled` | The task was cancelled |

Allowed transitions, in addition to updates within the same state:

- queued → executing / blocked / cancelled
- executing → blocked / awaiting_verification / failed / cancelled
- blocked → queued / executing / failed / cancelled / awaiting_verification
- awaiting_verification → executing / blocked / failed / cancelled
- completed → executing, with an explicit reason to reopen
- failed → executing / cancelled
- cancelled → queued / executing
- awaiting_verification → completed, exclusively through `complete`

Status changes require a reason. Completion requires a summary and evidence. Completed or skipped steps require evidence or a reason. Small tasks may have no steps, but still require current passing acceptance checks.

## Acceptance semantics

Each check contains its name, pass/fail result, performed-at timestamp, evidence, and `work_revision`. The latest result for each name at the current work revision is authoritative. Any current failure blocks completion.

Changing titles, goals, steps, blockers, next actions, result links, or status conservatively invalidates previous checks. Record work changes and enter `awaiting_verification` before performing and recording acceptance. Ordinary events and observations do not invalidate checks. Reopening retains historical checks and clears completion; old evidence cannot complete the reopened work.

`check` records a check already performed. It cannot determine whether a claim such as "tests passed" is true. `doctor` / `verify` check local integrity, not user-goal acceptance or platform memory.

## Time and observations

Timestamps are UTC ISO 8601 with six fractional digits and `Z`. Existing microsecond precision is preserved for ordering and comparisons. Views show a UTC date and minute. Render time differs from the latest check time.

`last_checked_at` records the latest execution-source observation or acceptance check; it does not imply live health, source reliability, or a passing result. Inspect the source and evidence. Active observations older than `stale_hours` (default 24) are stale. Unchecked tasks remain unknown; terminal tasks describe recorded outcomes, not live execution promises.

`execution` contains the latest observed run reference, not every historical run. Events retain earlier observations. `inProgress` may be stale and `completed` means a turn ended. When a source supplies a monotonic version, `source_version` prevents equal/older versions or unversioned observations of the same source/run from replacing it. Timestamps cannot regress either. The scheduler consumes local durable events; querying or creating platform tasks belongs to dot's actual tools. See [scheduling.md](scheduling.md) for the active wait loop, delivery state machine, and recovery contract.

## Local initialization and platform memory

Successful `init` creates or reuses local ledger files. The output includes `initialization_scope: "local_files_only"` and `assistant_memory.status: "not_checked"`; these describe the CLI's responsibility, not a persisted memory state. No task-store file can prove that a platform remembered the usage convention.

The invoking assistant follows [first-use.md](first-use.md) using actual user authorization and the platform's supported memory capability. Only locations and the usage convention belong in memory. Task facts belong in the ledger. Memory is not a scheduler, does not synchronize local and cloud stores, and does not grant permission to inspect unrelated tasks or accounts.

## Atomic writes, concurrency, and recovery

All Node CLI reads and writes hold the store's `.lock-node` directory lock. `wait` releases it between bounded queue scans. A complete candidate directory containing a unique owner token, PID, and hostname is prepared on the same disk, then renamed atomically to the fixed lock path. An occupied nonempty lock cannot be replaced. If the same-host owner is confirmed dead, only its unique token is removed and a nonrecursive directory removal reclaims the empty lock. An old reaper cannot recursively erase a new owner's generation. Live or unprobeable owners are preserved; possible PID reuse can cause a conservative busy timeout.

The store root is canonicalized before locking. Its ephemeral `.lock-node` leaf is checked with `lstat` inside the acquisition loop, without a subsequent `realpath` call that could race with the owner's release. A disappearing lock/owner is retried; symlinks, non-directory lock entries, permission failures, and other filesystem errors are not treated as an absent lock.

Writes use same-directory temporary files, fsync, and atomic replacement. Each transaction first persists its complete recovery journal, then applies task, projection, index, and any scheduler writes. The next CLI operation replays an interrupted transaction while holding the lock. Scheduling state is created lazily; opening or initializing a legacy store does not add it.

Consistency guarantees apply to single-host processes using this CLI. Direct filesystem readers may observe a transaction between writes. Avoid NFS, object-store mounts, multi-host writers, or incompatible implementations without verified locking semantics. Stop old writers before switching from a `flock` implementation; its lock and this directory lock do not interoperate. A legacy `.lock` file can remain. Crashes may leave candidate directories; unknown contents are never automatically removed.

After a disconnect following a possible commit, inspect the latest record before retrying. Ordinary ledger `event` entries do not have automatic deduplication. Scheduling events and requests use stable caller-supplied IDs; recorded scheduling receipts and acknowledgement retries are idempotent. Source-bound registration is idempotent; ordinary duplicate task IDs and duplicate result URLs are rejected.

Malformed JSON, unknown schema versions, inconsistent indexes, orphaned directories, and incorrect projections cause `doctor` to fail. Preserve originals and diagnostics before deciding on repairs; do not delete a pending recovery journal manually.

Store roots permit system and user directory aliases. Node filesystem APIs resolve each component before `..` and normalize existing path spelling. Aliases of the same store share one lock. Store-internal files, subdirectories, locks, and journals reject symlinks, as do unsafe task IDs. Output guards use physical paths; dangling/cyclic links and non-directory parents fail. Locks and permissions prevent mistakes, not malicious changes by another process with the same account's write access.

## Language and compatibility

New automatic event labels and generated projection headings are English. User task content and historical events keep their original language. Existing schema-1 projection sets in the legacy format remain valid without read-time rewrites. After an authorized mutation, that task's complete projection set is regenerated in English. Integrity checks accept either complete known format, not arbitrary text or a mixture of formats. No task-schema migration is required.

Optional `summary` provides concise progress; older records may omit it. Summary-only edits do not increment the work revision or invalidate checks. Default lists select the ten most recently updated active records (`queued`, `executing`, `blocked`, `awaiting_verification`) before grouping. Terminal records remain accessible through explicit history/state queries and detail views, including records with scheduling or notification issues. Selection preserves microsecond ordering and never mutates task records. `completion.at` remains the actual completion time, even after later events. Read operations change neither timestamp. Scheduling details are joined for rendering, not persisted into the task schema or projections.

## Attachment state

Optional `integration.json.uploads` stores authorized host-local file descriptors, SHA-256, app/platform binding, upload intent and resource receipt, independently of the message outbox and actual message IDs. Both use the existing lock/recovery journal. It contains no payload bytes. See [attachments](attachments.md) for read-only recovery and source-bound replies. Old schema-1 stores need no migration or upload access.

## Notification and inbox transactions

The optional schema-1 integration records and their transitions are defined in [connectors.md](connectors.md). A meaningful task mutation and its destination-scoped notification snapshots share one recovery journal. A consumed legacy command, dedup record, cursor and resulting scheduler request or reply likewise share a journal. All-sender intake uses one account policy and records provenance on every request without a setup message or per-sender binding. Its frozen reply routes refer to the original inbox record, so later senders cannot change queued recipients. Agent-mode ingestion atomically persists the bounded private text envelope, trigger provenance and dedup/checkpoint; a later fenced agent decision atomically creates or links a task, stores its sanitized decision, and queues its authorized response. Scheduling actual work is a separate idempotent step performed by dot before intake acknowledgement. Delivery acknowledgements never change task status or create another task event. Adapter bindings and queued routes are immutable; unknown delivery requires reconciliation. Rendered pending/failed/unknown delivery summaries join the existing UI without rewriting task records. Old stores need no migration until integration is configured.
