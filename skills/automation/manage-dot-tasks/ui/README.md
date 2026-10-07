# Task views

The durable state machine and acceptance rules are unchanged. CLI view labels retain English by default; select `render ... --language zh` for this workflow. Task notifications default to Chinese. Original task content is not translated.

## Displayed states

Markdown views and structured card responses distinguish queued, executing, blocked, awaiting verification, completed, failed and cancelled. Labels follow `--language`; task content keeps its original language. Legacy document-only adapters retain the previous four-label projection for compatibility.

Do not show raw `executing` or `awaiting_verification` as a user status. An ended execution does not imply success. Authorized requests whose parsing/creation failed appear in “未创建的请求” with 失败, a request ID, actual failure stage and reason, without a fabricated task.

## List and detail

`list.md` contains a title, one section per status, and task titles with concise progress descriptions. Group boundaries use a horizontal rule and a heading. Default lists select the ten most recently updated active records before grouping. `--all` includes terminal records and removes the limit; `list --status STATE` explicitly queries up to ten recent records of that state. Scheduling and notification issues remain separate from task acceptance.

`task-detail.md` shows the task name, specific status, summary and populated goal/next/steps/checks/results sections. It omits repeated titles and empty sections. Blockers and failed checks stay visible; the full record and stable ID remain available with `show`.

Both templates put a subdued timestamp at the bottom. Completed details use the actual acceptance time, not a later edit time. List time describes this ledger query, not external live execution.

Placeholders: list uses `$list_title`, `$tasks`, `$coverage`, `$footer`; `$generated_at` remains available to custom templates. Detail uses `$title`, `$status_badge`, `$summary`, `$sections`, `$footer`; `$id` and `$updated_at` remain available to custom templates. Templates control layout only. Stored schema-1 projections retain their existing compatible format.


## Time and renderer constraints

User-view timestamps use `Asia/Shanghai` and `YYYY-MM-DD HH:MM:SS` without fractional seconds. The implementation is centralized in `scripts/presentation.mjs`; record storage remains timezone-aware ISO. Generation time, task update time and actual completion time remain distinct.

Ordinary dot/local replies default to Markdown. A reply through a selected, started Feishu connection uses its native-card route. This choice never starts a service or changes a message destination. Markdown uses headings, whitespace and rules; structured Feishu cards use spaced status groups, gray headings and native dividers. Source, coverage and known timestamps follow the main content. See [response presentations](../references/reply-presentations.md).

Legacy document-only adapters retain their earlier table/title-time layout. All card text remains in native plain-text nodes and result links use verified URL buttons. No renderer turns task content into executable actions. Pixel spacing and wrapping depend on the receiving client; local previews and JSON tests do not prove live Feishu rendering.

Failure cards retain the recorded terminal-state reason even when an earlier summary exists, and show a useful next action. Receipt acknowledgements say that the request is queued for review; they do not claim task creation or execution success.
