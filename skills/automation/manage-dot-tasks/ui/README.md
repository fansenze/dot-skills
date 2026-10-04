# Task views

The durable state machine and acceptance rules are unchanged. CLI view labels retain English by default; select `render ... --language zh` for this workflow. Task notifications default to Chinese. Original task content is not translated.

## Four displayed states

| Internal state | Chinese status | English status | Required explanation |
| --- | --- | --- | --- |
| queued | 排队中 | Pending | Actual next action when known |
| blocked | 排队中 | Pending | Explicitly blocked/waiting; full reason and user action, never a claim of running |
| executing, awaiting_verification | 执行中 | In progress | Current work/checking summary |
| completed | 成功 | Succeeded | Actual acceptance time and completion result |
| failed | 失败 | Failed | Actual failure and useful next action |
| cancelled | 失败 | Failed | Explicitly cancelled and not completed |

Do not show raw `executing` or `awaiting_verification` as a user status. An ended execution does not imply success. Authorized requests whose parsing/creation failed appear in “未创建的请求” with 失败, a request ID, actual failure stage and reason, without a fabricated task.

## List and detail

`list.md` has a title with the generation timestamp appended on its right in the same line and Title / Status / Summary columns. Completed rows use actual `completion.at`; their inactivity filter stays ten minutes except for scheduling/notification issues. `--all` reveals old completed tasks without deleting anything. Pending, failed and unknown delivery remain in the summary independently of acceptance.

`task-detail.md` uses the actual task name as its heading, then stable ID, status, concise summary and populated goal/next/steps/checks/results sections. It is not a one-row list. Do not repeat the task title as a body field or create empty sections. Current failed checks and full blockers must remain visible. The original event/check history remains available with `show`.

Placeholders: list uses `$list_title`, `$generated_at`, `$tasks`; detail uses `$title`, `$id`, `$updated_at`, `$status_badge`, `$summary`, `$sections`. Templates control layout only. Existing schema-1 task projections retain their compatible timestamp/byte format; this change affects user views.

## Time and renderer constraints

User-view timestamps use `Asia/Shanghai` and `YYYY-MM-DD HH:MM:SS` without fractional seconds. The implementation is centralized in `scripts/presentation.mjs`; record storage remains timezone-aware ISO. Generation time, task update time and actual completion time remain distinct.

CommonMark headings and the current native Feishu card title field cannot guarantee a separate, flush-right timestamp. The explicit portable design is `Title · YYYY-MM-DD HH:MM:SS` on the heading line; Markdown uses `<sub>` where supported. Long headings may wrap on a narrow screen. Do not claim actual right alignment, gray color or identical mobile/desktop layout without live evidence.

List cards use native weighted columns with plain-text cells, avoiding unsupported Markdown tables and active mentions/actions. Single-task cards have the task title, timestamp, stable ID and detail paragraphs, with no list heading or table columns. Text and Markdown transports use safe lines. Result links must be real and audience-accessible. No renderer turns untrusted task/post text into code or additional authorization.

Failure cards retain the recorded terminal-state reason even when an earlier summary exists, and show a useful next action. Receipt acknowledgements say that the request is queued for review; they do not claim task creation or execution success.
