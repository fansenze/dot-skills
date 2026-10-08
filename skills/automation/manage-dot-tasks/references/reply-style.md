# Reply style and template references

These references accompany the user's message before dot drafts a Feishu reply. Aim for calm, clear, conversational messages that are easy to read on a phone. The examples illustrate wording and information order, not a mandatory outline. Adapt them to the request; the user's instructions and preferences take precedence.

## Reply surface

Use Markdown by default in ordinary dot/local conversations without an active Feishu reply route. For the selected, started Feishu integration, record a semantic `response` and use its native-card route. Keep the same content hierarchy and facts in both: distinct status groups, task titles followed by concise descriptions, useful detail sections and footer time. Markdown uses headings, whitespace and rules between groups; cards use native components. Do not paste card JSON into chat or send Markdown source as a card's plain content. Existing explicit per-message format requests still take precedence. An installed or unused connection is not permission to start it or redirect a reply.

For automatic completion notifications, write a concise user-facing completion summary. Describe the result and useful timing; keep raw acceptance evidence, scheduler syntax and implementation logs in the ledger. Do not repeat the durable receipt in a substantive response. Feishu topic follow-ups use the `Get` reaction as their receipt; the first topic message retains the short text receipt.

## Style

- Answer the actual question first, in the user's language. An ordinary answer can be a short paragraph without a task title or a status report.
- Make the opening useful on its own: give the result, the current situation or the one missing detail. Phrases such as "The current status is as follows" add little.
- For a result, say what was delivered and what it covers. For ongoing work, say what has changed or what remains. Include a blocker or a request for confirmation only when there really is one.
- Omit internal headings such as "Task conversation", "Task response" and repeated task titles. Use a short, specific topic title only when it helps. Let the opening add information instead of repeating the title. Keep independent points on separate lines, with enough space to scan them. A simple reply need not have sections, a preamble and a closing summary.
- In an overview, give each task one distinct entry. Let its explanation add a concrete fact rather than repeat its title or status. Put the item needing attention where the reader can find it quickly.
- Keep internal IDs, raw logs and redundant counts out of the authored explanation unless the user needs them. Put useful source and time information after the main content. State a real coverage limit clearly. Use descriptive labels in `links` for actual result URLs, placed near the result they explain. The renderer emits native Markdown text hyperlinks; reserve buttons for actual actions. Write real paragraph/newline characters before JSON serialization, never literal backslash-n text.
- Prefer restrained presentation: a clear main point and concise supporting text. Use short paragraphs or a compact list instead of a wide table for routine chat. Avoid decorative separators, repeated emoji, elaborate headings and a label on every sentence. Let the existing output format handle presentation.

## Default task lists and time

- For an ordinary task-list request, use `context.task_list`: at most 10 recently updated active tasks (`queued`, `executing`, `blocked`, `awaiting_verification`), already selected within the grant. This is a bounded ledger snapshot, not proof of live platform execution or complete discovery. Do not fill the list from the separate association context or historical records.
- With actual platform query tools, request the same active filter, descending update order and limit of 10 when supported. If filtering is unavailable, use one bounded recent page, filter it and show fewer results; do not scan old pages or full histories to fill ten slots. Query completed, failed or cancelled tasks only when explicitly requested. A specific task question can use its verified identity regardless of status.
- Select records before grouping them by status. Distinguish queued, executing, blocked, awaiting verification, completed, failed and cancelled. Give each task a title and one concrete progress description; do not repeat the group status on every row. Keep the blocker and required action visible.
- For default lists set `list_scope: "recent_active"` and `coverage: {"shown": N, "total": null}` when the global total is unknown. Use `history` or `selected` for explicitly requested alternative scopes. Do not infer complete coverage from a page containing fewer than ten tasks.
- Put known `data_time` and a short `time_label` at the bottom. Use the task's actual update/completion time for details, the bounded snapshot's `observed_at` for a list, and the actual reply time for an ordinary answer. Use labels such as "Updated", "Completed", "Checked", "As of", or "Replied" in the user's language. Preserve stale observation times; never label the send time as a fresh check. A short acknowledgement uses the chat's own message timestamp.
- For a single task, use top-level `status`, a concise lead and only populated goal, progress/steps, acceptance checks, blocker and next-action sections. Put verified result links after the supporting content. A choice uses numbered descriptions, not executable buttons.

## Existing templates

| Template | Suitable content | Composition reference |
| --- | --- | --- |
| `ack` | A short acknowledgement | One natural sentence; use when acknowledgement itself is useful |
| `list` | Several records, or an empty result | Distinct task entries with concrete progress; make anything needing attention clear |
| `detail` | An ordinary answer, one task or a result | Start with the answer or deliverable; add useful explanation, evidence or result links |
| `decision` | A genuinely unresolved question | Ask the missing question directly; explain the difference between meaningful options |
| `brief` | A report for a particular time | Highlight changes and what needs attention, with the relevant time and source |

## Illustrative examples

These are content sketches for the existing templates, not screenshots or additional output requirements. The task facts are fictional. Use the actual request and known facts; do not invent work, blockers or decisions to fill a pattern. Existing output formats and handling remain in place.

Short acknowledgement (`ack`):

```text
Received. I'll check the two versions.
```

Task overview (`list`):

```text
One task needs your confirmation; the installation guide is being checked.

Blocked · 1 task
Release notes
The draft is ready. Confirm whether unmerged changes belong in the release.

Awaiting verification · 1 task
Installation guide
The clean-environment walkthrough is still running.

Pending · 1 task
Release deployment
Scheduled for 14:00 today, as requested.

Showing 3 active tasks from this query; total unknown.
Checked October 7, 10:32 (Asia/Shanghai).
```

Ordinary explanation (`detail`), answering whether the workflow continues while dot is inactive:

```text
New messages can still be saved while dot is inactive, if the Feishu listener stays running.

Receiving a message does not itself wake dot. Dot needs to become active again to interpret it and arrange the next action.
```

A completed result (`detail`):

```text
Installation guide updated

Added the macOS and Linux setup steps, with troubleshooting for missing dependencies.

Both walkthroughs passed in clean environments. The updated guide is ready to use.
```

When an actual result URL is available, give it a descriptive label such as "Open the installation guide". Do not invent a URL or an attachment.

A necessary choice (`decision`), when a stop request refers to two tasks with the same name:

```text
I found two tasks called "Weekly report". Which one should I stop?

This week's report — currently collecting merged PRs.
Monday schedule — generates a report every Monday at 09:00.
```

A daily brief (`brief`):

```text
Today's progress

The weekly report is ready, and the installation guide has passed its final checks. Deployment is scheduled for 14:00.

Completed
• Weekly report: 12 merged PRs organized by topic.
• Installation guide: macOS and Linux walkthroughs verified.

Coming up
• Release deployment at 14:00, as requested.

As of October 5, 09:00 (Asia/Shanghai), from the task records reviewed for this brief.
```
