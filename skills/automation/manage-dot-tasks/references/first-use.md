# Installation, First Use, and Remembered Rules

Run this workflow when dot installs, enables, or first uses the skill for the user. The assistant conducting setup must use dot's existing memory capability to remember the authorized rules during that same turn. Do not stop after copying the skill or initializing files, and do not leave the memory step as a suggestion for the user to request again. Later invocations verify and reuse the convention.

This is an assistant installation procedure, not an executable package hook. Copying files or clicking an installation UI without an assistant executing these instructions does not itself run the memory step. In that case the first assistant invocation must complete it. Running `node taskctl.mjs init` alone performs only the local step. No new memory storage layer or API is required.

## Initialize the selected local store

Resolve the actual skill location and the intended task-store location in the current environment. Respect explicit user selection. If a previously remembered location is relevant and accessible, reuse it; do not silently substitute a local path for a cloud store, create a second ledger, or synchronize the two.

Run `init` with the selected store. `initialized: true` means files were created; `initialized: false` means an existing valid store was reused. Both successful results return the resolved store location and:

```json
{
  "initialization_scope": "local_files_only",
  "assistant_memory": {
    "status": "not_checked",
    "handled_by": "invoking_assistant",
    "workflow": "references/first-use.md"
  }
}
```

`not_checked` describes the CLI's knowledge. It does not assert that memory is absent, unavailable, or saved. Do not persist a substitute memory status in store metadata, a task, or a marker file. `doctor` cannot verify platform memory.

## Establish or reuse the convention

1. **Use existing authorization.** An explicit instruction to remember the task-management rules automatically during installation authorizes performing this step as part of setup. Proceed without asking for the same consent again. Reusing an already authorized matching convention also requires no new save or renewed consent. Another user's consent does not transfer. If remembered setup is requested but consent for its scope is missing, ask only about that missing scope while continuing authorized work. For an explicitly local-only request, complete local initialization and report that memory was not attempted; do not add a memory-consent question or expand the task. Respect a refusal.
2. **Check actual capability.** Use only the platform's normal supported long-term memory functionality when it is exposed and available in this runtime. Do not invent a memory API, read private implementation files, or treat a local note as platform memory. If the capability is unavailable, report that the convention was not saved by this invocation.
3. **Look for the existing convention.** Consult the convention through the supported memory mechanism. Compare the skill, store, environment, task scope, and lifecycle updates. Reuse a matching convention without another write. If the result is incomplete or unavailable, preserve uncertainty instead of assuming absence and creating a duplicate. If a location or scope changed, update the existing convention only within the user's authorization; resolve ambiguity before switching stores or expanding scope.
4. **Save the rules during setup.** When authorized and no matching convention exists, immediately use the platform's existing memory capability to save the actual skill and store locations and the operational convention below. This action belongs to the installation/activation workflow, not to the Node script. Use the platform's supported update behavior for an existing convention. Do not include concrete task titles, goals, progress, evidence, results, credentials, or copied conversations in long-term memory.
5. **Verify persistence.** Use supported retrieval or an authoritative platform confirmation that the intended content was persisted. Verify the locations and agreed behavior. A queued/accepted request, an assistant promise, a successful CLI exit, or a local flag is insufficient. If saving fails, report failure. If the outcome or verification is uncertain, report it as unconfirmed; inspect existing memory before any later retry to avoid duplicates.
6. **Report the two outcomes.** State local ledger readiness separately from the observed memory result. Only claim the memory step complete after persistence is verified, or after retrieving an existing matching convention. Do not report the entire requested setup complete when required memory remains unavailable, failed, or unconfirmed. Continue authorized ledger work without pretending the missing memory step succeeded.

## Convention content

Use actual accessible locations and the user's agreed scope in a short preference such as:

> For user-assigned tasks in the agreed environment, use the manage-dot-tasks skill at the selected skill location and the ledger at the selected store location. On intake, find and reuse an existing task or register its goal and next action. Update the ledger promptly on progress and step changes, new or resolved blockers, and verified completion. Verify the requested outcome before marking a task complete; a finished execution turn alone is insufficient. Read the ledger and render its list or detail view for status requests. Keep concrete task details and evidence in the ledger.

The locations identify the skill and ledger; they are not paths to a memory implementation. Do not make a blanket promise about unrelated conversations or other environments. Future assistants must use whatever remembered preferences and capabilities the platform actually exposes. A memory convention does not run code, poll activities, subscribe to events, schedule work, or guarantee that every task across dot is observed.

## Later invocations

Use the currently available remembered convention, verify it still matches the selected locations and agreed scope, and reuse it. Do not save it again merely because `init` returns `initialized: false` or `assistant_memory.status: not_checked`. If prior saving failed or was unconfirmed, re-check the supported memory source before attempting another write. Do not automatically retry a failed external save in a loop.

During the active task, maintain the ledger at each meaningful lifecycle change as directed by `SKILL.md`. Updates result from the invoking assistant doing work or checking a source; remembered preferences are not an always-running service.

## Evidence-based reporting

The local-readiness wording below assumes initialization actually succeeded. Otherwise report the observed local failure; a memory result cannot establish ledger readiness.

| Observed outcome | Report | Next action |
| --- | --- | --- |
| New convention persisted and verified | Local ledger ready; convention saved and verified | Continue task work |
| Existing matching convention retrieved | Local ledger ready; existing convention verified and reused | Continue without another save |
| Consent missing or declined | Local ledger ready; convention not saved | Ask only for requested memory setup; respect refusal and local-only scope |
| Memory capability unavailable | Local ledger ready; convention not saved in this runtime | Continue authorized ledger work |
| Save failed | Local ledger ready; convention save failed | Preserve the result; no blind retry |
| Save accepted but persistence unconfirmed | Local ledger ready; convention persistence unconfirmed | Verify through the platform before claiming success or retrying |
| Existing memory lookup failed | Local ledger ready; existing convention could not be verified | Do not create a duplicate based on an assumed absence |

These are assistant reporting outcomes, not writable CLI memory states. Actual dot memory verification requires the supported capability in a dot invocation; the local scenario checks cannot substitute for it.
