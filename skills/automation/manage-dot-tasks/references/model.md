# Data Model, States, and Reliability

## File layout

```text
task-store/
  store.json                    # Schema, creation time, freshness threshold, note
  tasks.json                    # Lightweight id/title/status/updated_at index
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

`execution` contains the latest observed run reference, not every historical run. Events retain earlier observations. `inProgress` may be stale and `completed` means a turn ended. The script does not poll, subscribe, or schedule work.

## Local initialization and platform memory

Successful `init` creates or reuses local ledger files. The output includes `initialization_scope: "local_files_only"` and `assistant_memory.status: "not_checked"`; these describe the CLI's responsibility, not a persisted memory state. No task-store file can prove that a platform remembered the usage convention.

The invoking assistant follows [first-use.md](first-use.md) using actual user authorization and the platform's supported memory capability. Only locations and the usage convention belong in memory. Task facts belong in the ledger. Memory is not a scheduler, does not synchronize local and cloud stores, and does not grant permission to inspect unrelated tasks or accounts.

## Atomic writes, concurrency, and recovery

All Node CLI reads and writes hold the store's `.lock-node` directory lock. A complete candidate directory containing a unique owner token, PID, and hostname is prepared on the same disk, then renamed atomically to the fixed lock path. An occupied nonempty lock cannot be replaced. If the same-host owner is confirmed dead, only its unique token is removed and a nonrecursive directory removal reclaims the empty lock. An old reaper cannot recursively erase a new owner's generation. Live or unprobeable owners are preserved; possible PID reuse can cause a conservative busy timeout.

Writes use same-directory temporary files, fsync, and atomic replacement. Each transaction first persists its complete recovery journal, then applies task, projection, and index writes. The next CLI operation replays an interrupted transaction while holding the lock.

Consistency guarantees apply to single-host processes using this CLI. Direct filesystem readers may observe a transaction between writes. Avoid NFS, object-store mounts, multi-host writers, or incompatible implementations without verified locking semantics. Stop old writers before switching from a `flock` implementation; its lock and this directory lock do not interoperate. A legacy `.lock` file can remain. Crashes may leave candidate directories; unknown contents are never automatically removed.

After a disconnect following a possible commit, inspect the latest record before retrying. Events do not have automatic deduplication. Duplicate task IDs and duplicate result URLs are rejected.

Malformed JSON, unknown schema versions, inconsistent indexes, orphaned directories, and incorrect projections cause `doctor` to fail. Preserve originals and diagnostics before deciding on repairs; do not delete a pending recovery journal manually.

Store roots permit system and user directory aliases. Node filesystem APIs resolve each component before `..` and normalize existing path spelling. Aliases of the same store share one lock. Store-internal files, subdirectories, locks, and journals reject symlinks, as do unsafe task IDs. Output guards use physical paths; dangling/cyclic links and non-directory parents fail. Locks and permissions prevent mistakes, not malicious changes by another process with the same account's write access.

## Language and compatibility

New automatic event labels and generated projection headings are English. User task content and historical events keep their original language. Existing schema-1 projection sets in the legacy format remain valid without read-time rewrites. After an authorized mutation, that task's complete projection set is regenerated in English. Integrity checks accept either complete known format, not arbitrary text or a mixture of formats. No task-schema migration is required.

Optional `summary` provides concise progress; older records may omit it. Summary-only edits do not increment the work revision or invalidate checks. Default list filtering hides only completed records inactive for ten minutes. `completion.at` remains the actual completion time, even after later events. Read operations change neither timestamp.
