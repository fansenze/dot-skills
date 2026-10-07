# Integrated startup acceptance scenarios

These scenarios test the canonical [startup workflow](../references/startup.md). Use isolated temporary stores, fabricated identities and the fixture connector; no credentials, real messages, live listener, permanent memory activation or background monitor. Agent decisions in automated tests are scripted inputs, not an NLP evaluator.

## Prompt comparison

- **Procedure-heavy baseline:** the previous README asked the user to recite routing, dependencies, receiver reuse, grants, cards, source discovery and start/record/ack loops. It mixed intent with implementation and still allowed a watch plus grant to duplicate updates.
- **Too short:** “Install and start task management” supplies neither a Feishu destination nor intake/notification scope. Correct outcome is local setup plus a focused question, not silently enabling everything.
- **Selected primary:** the [startup prompt](../references/startup.md#interpret-intent-then-fill-only-real-gaps) explicitly selects dot for the Feishu service and task management while naming a separate configuration source. It supplies intake from any sender, existing/new dot/Codex task scope, completion notifications and a brief startup confirmation in dot. The skill transfers a selected computer-local configuration through Library and verifies its received bytes; sender and chat metadata come from actual requests.
- **New-only alternative:** state only tasks created through the chat and their progress/results. No pre-existing task disclosure or initial all-task watch.
- **Resume:** retain the selected service host, verified runtime/configuration, chat and scope. Read revoked/disabled state first; a generic setup request is not authorization to undo a revocation.

## Executable local experiments

Run `node --test tests/startup.test.mjs`. It executes actual CLI processes for fresh init, connection/grant/watch registration, and three repeated startup/idle cycles. Each fixture asserts persisted state and actual mock transport effects, not just intended commands.

| Scenario | Expected evidence |
| --- | --- |
| Fresh setup and three repeats | One binding/grant/watch, unchanged cutoff, one initial card effect; init still reports memory not checked |
| New-only ordinary Chinese request | Existing task absent from claim context; one scripted decision creates one task; repeat record reuses it; no scheduler dispatch invented |
| Associated task update | One progress effect when a same-route watch matches; original decision reply retained |
| Watch disabled, different task or event | Grant update remains deliverable |
| Different destination or format | Both intentionally different updates remain |
| Second explicit watch | Explicit subscriptions stay separate |
| All-scope new task | New-task progress covered once; decision reply remains |
| Missing sender or revoked grant | Missing identity rejected; init/read/start leave revoked scope disabled |

Run the complete task tests for claim expiry, lease fencing, process crashes, recorded/ack recovery, source coverage and unknown-send no-retry. Run Feishu routing/lifecycle tests for configuration identity and connection evidence; run bridge orchestration tests for exact batches, matching worker reuse and late receipts. Those use local synthetic counterparts and do not create a real platform child task.

## Agent review cases (not autonomous or live execution proof)

Review these against startup.md and the supporting contracts; record any unresolved evidence as a blocker.

1. **Mac source, service on dot:** the setup prompt authorizes transfer of its selected configuration. Use the internal Library skill for upload and materialization, verify the unchanged bytes on dot, and use that path with the direct adapter. Keep the receiver on dot. Synthetic files model the handoff without a real Library upload.
2. **Existing dot configuration:** use the pinned dot runtime and direct adapter without a local worker or file transfer. Missing dot-local configuration blocks this route even if a readable Mac source exists.
3. **Existing verified identity:** reuse exact app/brand/tenant/sender/chat evidence, original grant cutoff and IDs. No compulsory fresh message or duplicate setup send.
4. **Open intake without recorded identity:** configure all-senders from the authorized scope and start consuming. After the receiver is connected and the consumer is active, give one brief startup confirmation in dot. A PID or prepared configuration alone does not prove readiness. Ask for no binding code, seed message or sent confirmation. The first real request must both record the provider identity and enter ordinary agent review. An arbitrary newest historical record does not establish ownership.
5. **Missing task scope:** ask new-only versus specified existing tasks. An explicit category grant covers only that category. In a mixed ledger, resolve IDs rather than using all. Honor a user-selected task executor independently of transport ownership.
6. **Partial source discovery:** bind verified identities; record partial/unavailable coverage. Do not imply complete discovery or disclose unrelated records in a requested overview.
7. **Matching receiver exists:** require selected config/account/brand/state and current lifecycle evidence, reuse its handle. Without that evidence, inspect rather than start a duplicate or claim connected.
8. **Idle/yield/recovery:** collect yielded session result, re-arm normal timeout, retain existing decision/intent/receipt IDs after interruption; stop affected operations on persistent gaps without spinning.
9. **Memory:** reuse a verified existing usage convention. Local init does not prove platform memory; report unavailable persistence separately.
10. **Explicit computer hosting:** select the bridge only when the user requests that host; reuse one verified task and keep configuration/transport there while the ledger stays on dot. Missing tools block this route without changing hosts.
11. **Old installation or unknown revision:** compare the actual installed files with the requested revision/manifest. Do not trust a matching skill name or package version. Stop for an unavailable update; preserve state/receipts. After verification, use one fixed absolute runtime root even if the working directory or catalog points to an older copy.
12. **pnpm child lookup:** a parent invocation of pnpm 11.27.0 does not prove that child scripts find it. Put the verified bin directory first on PATH, propagate that environment to later calls and verify a Node child's version before dependency setup/checks.

These checks establish implementation and instruction consistency. They do not establish real Feishu network delivery, a running user's receiver, platform-memory persistence, agent interpretation quality across arbitrary prompts, full platform discovery, or permanent background availability.

## Threaded post intake and completion-only acceptance

Use synthetic text/post inputs in the verified scope. Expect one receipt acknowledgement before work; malformed authorized input produces one failed-request response, while wrong sender/destination and old input produce none. Confirm the original post/content_v2 representation is not duplicated, old rejected IDs are not replayed, and task creation recovery preserves one task.

Display only 排队中 / 执行中 / 成功 / 失败 with Asia/Shanghai seconds. Blocked tasks must show a stopped/waiting reason; cancelled tasks must explicitly say cancelled. Querying one task uses its name as title and stable ID with no one-row list. Changes during execution/verification do not send proactively. After verified complete, drain one completion notice in the original topic; an unknown receipt never triggers blind resend.

Reply to an original incoming message, an older accepted bot reply, and a thread-only reference. Confirm scoped reference evidence and stable Codex/dot bindings remain available. An explicit session query is interpreted by the agent; ambiguous new text remains unassigned until clarified. Different senders/destinations cannot contribute conversation history. Report 20-reference/50-task/200-source truncation instead of assuming complete coverage.

Historical failure annotations never send/replay. Newly unrecoverable creation failures use message-fail only after checking journal, decision and source binding. Run the parent-coordinated fictional demo only after deployment and explicit messaging authorization.

## Intake without a setup message

Run `node --test tests/received-intake.test.mjs` with its temporary store and local fixture. Review startup with no recorded target: SDK lifecycle establishes connection readiness and each actual request records its source while immediately entering ordinary processing. Anyone may send a request; no whitelist, challenge or per-sender grant is created. Restart must preserve the one policy, cutoff, message provenance, decisions and source bindings. Different senders/chats must remain separately attributable with replies routed to their actual origins. Selecting open intake supersedes sender-specific admission rules for new messages and cancels pending challenges. Successful startup produces a brief readiness confirmation in dot.

## Periodic startup contract review

Review the new-instance workflow using synthetic state only. Platform scheduling must be exercised by dot's actual automation tools, not represented by a Node test result.

- Full startup intent: preserve host/config/task/reply scope and explicit periodic-check/recovery authorization. Verify the enabled ten-minute automation and wait for its scheduled invocation before full success; manual `run_now` alone is insufficient.
- Initial ordering: finish one bounded initial consumer call, establish/reuse the owning service context, create and verify the automation, then continuously re-arm; fresh installation requires no historical service record.
- Live session: timed check reuses one receiver and then collects/re-arms the bounded consumer. Health without consumption is incomplete.
- Lost session: one locked replacement attempt; held flock, network denial, unavailable context or unknown effects block unsafe takeover/replay. Successful replacement resumes consumption with existing IDs and scopes.
- Stop: record cancellation in the existing owning context first, disable/verify this instance's automation and grant/connection, then EOF the owned session; an already queued invocation reads latest stop and does nothing. A stopped or revoked scope must never be revived by setup or inspection.
- No recurring authority or explicit opt-out: do not create an automation. Report foreground-only readiness and its limits without inventing missing permission.

Run `node --test tests/managed-session.test.mjs tests/startup.test.mjs` for existing synthetic ownership, receiver reuse, safe replacement, EOF cleanup, intake and receipt preservation. These tests do not prove platform scheduling or live Feishu behavior.
