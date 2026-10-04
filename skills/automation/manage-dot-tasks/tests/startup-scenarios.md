# Integrated startup acceptance scenarios

These scenarios test the canonical [startup workflow](../references/startup.md). Use isolated temporary stores, fabricated identities and the fixture connector; no credentials, real messages, live listener, permanent memory activation or background monitor. Agent decisions in automated tests are scripted inputs, not an NLP evaluator.

## Prompt comparison

- **Procedure-heavy baseline:** the previous README asked the user to recite routing, dependencies, receiver reuse, grants, cards, source discovery and start/record/ack loops. It mixed intent with implementation and still allowed a watch plus grant to duplicate updates.
- **Too short:** “Install and start task management” supplies neither a Feishu destination nor intake/notification scope. Correct outcome is local setup plus a focused question, not silently enabling everything.
- **Selected primary:** the [startup prompt](../references/startup.md#interpret-intent-then-fill-only-real-gaps) explicitly selects dot for the Feishu service and task management while naming a separate configuration source. It also supplies private-chat intent, existing/new dot/Codex task scope, natural-language intake and initial/progress updates. The skill transfers a selected computer-local configuration through Library, verifies its received bytes, and verifies recipient identity before disclosure.
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
4. **Missing or ambiguous identity:** continue ledger initialization, ask only for missing mapping or ownership evidence. An arbitrary newest inbox record does not satisfy it.
5. **Missing task scope:** ask new-only versus specified existing tasks. An explicit category grant covers only that category. In a mixed ledger, resolve IDs rather than using all. Honor a user-selected task executor independently of transport ownership.
6. **Partial source discovery:** bind verified identities; record partial/unavailable coverage. Do not imply complete discovery or disclose unrelated records in the initial overview.
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
