# Task Views

Fixed view labels default to English. `render ... --language zh` explicitly selects Chinese labels; task titles, summaries, goals, and evidence retain their original language. Documentation and CLI-generated event labels are English.

The two independent Markdown templates use `$name` or `${name}` placeholders. Use `$$` for a literal dollar sign. Templates control layout only; they do not change records or acceptance rules.

## List: list.md

Use a title, subdued generation time, and the three columns Title / Status / Summary. Do not add counts, an overview, an attention section, a legend, or repeated explanations.

- `$list_title`: `Tasks` by default.
- `$generated_at`: the current render time with timezone, not the latest task check.
- `$tasks`: an escaped three-column table, or `No tasks` if none are visible.
- Completed tasks show `✅` plus the actual `completion.at`. Active, blocked, awaiting-verification, and failed tasks show `🚧`. Queued and cancelled tasks show `🕒`.
- Explain blocked, awaiting-verification, failed, and cancelled states in Summary without adding a legend.
- Prefer the short recorded `summary`, then a progress event, active step, or next action. Completed rows use the completion summary. Current failed checks remain visible.
- Hide only completed tasks whose `updated_at` is at least ten minutes old. Recent completed tasks and all unfinished tasks remain visible. `--all` includes hidden records; filtering never deletes data.
- Reading or rendering does not refresh task activity. Use neither render time nor update time in place of completion time.
- Active scheduling is joined into Summary: scheduled time, processing, retry, reconciliation, or failure. The same task keeps its existing status badge and acceptance meaning. An active schedule keeps an otherwise hidden completed task visible in rendered views; `list` remains the compatible lightweight task index.

## Detail: task-detail.md

Use the title, subdued task update time, the same status marker, and a current summary. Add Goal, Next, Steps, Checks, and Results only when they have content. Avoid numbered overviews, a full timeline, empty sections, or generic state explanations.

- `$title`, `$updated_at`, `$status_badge`: task title, actual activity time, and status.
- `$summary`: concise current facts, preserving blocker, failure, and verification meaning.
- `$sections`: populated paragraphs and sections; show step titles and reasons for skipped steps.
- Current failed checks cannot be displaced by many passing checks. Historical checks do not become current acceptance; show `Reverification needed` when appropriate.
- A short summary does not hide the full current blocker. For stale execution observations, show the actual observation time and `update needed`.
- Original step evidence, check history, and events remain available through `show ID`.
- Scheduling appears in the summary when present; `queue --task-id ID` exposes details separately. Ordinary tasks render identically when no scheduling exists. Source coverage is reported through `coverage` and the assistant's scoped status report, without adding columns or generic warnings to every task.

## Markdown and message adaptation

Escape pipes and Markdown/HTML in single-line content. Collapse line breaks without creating extra table columns. `<sub>` denotes subdued timestamps; do not claim an unsupported renderer actually displayed gray text.

A separately authorized Lark/Feishu sender should map the timestamp to a gray `note` and the three columns to native `column_set` elements with weighted widths instead of placing unsupported Markdown tables inside `lark_md`. Map detail titles, timestamps, and bodies to the appropriate card elements. Keep these Markdown files as reusable source templates. The bundled Feishu adapter implements this mapping for explicitly authorized subscriptions through the transactional outbox. Explicit Markdown/text formats render escaped lines, without silent fallback.

Do not infer completion from empty values or generate links to nonexistent detail pages. Only bundle titles link to generated detail files. Failed tasks should retain their explanation and useful next action. Keep summaries to one or two facts, not copied logs or long acceptance text. Result links must be real and accessible to their audience; local paths are not web links.

Notification pending, failed and unknown-delivery states join Summary without changing the status badge or acceptance outcome. They keep affected completed tasks visible until delivery is settled or cancelled. Notification receipts do not trigger further notifications. Cards preserve user content as plain-text cells; live client rendering requires separate acceptance.
