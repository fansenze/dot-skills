# Task/server integration contract (protocol 1)

This is a module boundary inside Manage Dot Tasks, not a second task product. The public entry point is `taskctl.mjs`; its existing list/detail/bundle UI remains the status surface. `scripts/connectors/contract.mjs` validates adapters, `connectors/feishu.mjs` invokes the independent server CLI, `integration.mjs` owns policy/outbox/inbound state, `scheduler.mjs` owns execution requests, and `taskctl.mjs` owns task acceptance and local transactions. No platform API is emulated.

## First setup and start

The invoking agent performs these steps for the user's “install and start manage-dot-tasks” request. Carry existing authorization forward; do not ask the user to implement code or install an MCP server.

1. Locate the task skill, message server and remote-config-bridge. Prefer verified installed skills; the repository contains `skills/messaging/feishu-message-server` and `skills/messaging/remote-config-bridge`, and the combined export contains all three as siblings. If the catalog is incomplete, inspect relevant `.agents/skills` in the authorized repository. **Route ownership first:** if dot orchestrates a user-computer configuration, invoke remote-config-bridge and follow its `references/orchestration.md` through one verified local task. That task invokes the Feishu CLI directly; do not recursively invoke its setup skill. Keep configuration/credentials/transport there. On dot register `remote-config-bridge/scripts/adapter.mjs` with only `{store,authorization_ref}` settings and pump its exact export/process/import batches via actual `cloud_threads.create`/`send_message`/`read` tools. These tools are called by the active agent, never Node. Do not continue the direct-adapter setup below with a remote path. The following steps are for same-environment configuration; remote orchestration keeps the same task policy and receipt contracts.
2. Initialize/reuse the selected external task store and follow `first-use.md` for authorized platform memory. Reuse the selected server configuration path and private state directory; `feishu.sh check --config FILE` and `identity --config FILE` inspect it without networking. Missing configuration remains a blocker for the transport, not for local task management. No secrets go in a task file or command argument. A selected user-computer configuration stays there through remote-config-bridge. This is operation transport, not arbitrary file export or a replacement for code distribution tools.
3. Run `feishu.sh capabilities`; require protocol 1 and only the capabilities used by the requested policies (see the matrix below). Resolve the actual app ID/brand and verified intended chat/sender/tenant from user input or existing evidence. Server identity verifies configuration selection, not the recipient. Never select the newest inbox record or infer an account/recipient from a name. Ask only for missing or ambiguous configuration/IDs/permissions/scope.
4. Write a private nonsecret settings JSON outside the skill: `{"server":"/absolute/feishu-message-server/scripts/server.mjs","config_ref":"/private/config.yml","state_dir":"/private/feishu-state","account_id":"verified-app-id","brand":"feishu"}`. These five keys are the only Feishu settings. Config path is a pointer; the task store never copies credentials. Preserve the config's lifetime for later sends. Credential persistence beyond the requested lifetime needs actual user authorization.
5. Register `connect`, then only the requested `watch` and `allow-inbound` policies using the examples below. Bindings/policies are immutable IDs; repeated identical registration is idempotent. To change an account, recipient, module, setting, capability or scope, disable the old ID and register a new one. Pending old messages never adopt a new route. `--initial` queues one initial overview on first watch creation only.
6. If receiver startup is authorized, reuse a matching live server (same config/account/brand/state directory and current lifecycle evidence), or start it in the environment's supported process session. Do not duplicate or restart a healthy receiver. Connection readiness requires `transport_connected`/`transport_reconnected` without a later disconnect/stop; PID/config/capabilities alone do not prove readiness. Record the session handle. A receiver is needed for new inbound messages, not for an outgoing send or local scheduling.
7. Call `taskctl start` and consume it actively. It reads allowed inboxes, sends outbox entries, and returns a scheduler batch. For that batch, use the actual tools with the scheduler's `begin → record → ack` protocol, then call `start` again. On yielded process handles, collect output until completion. Re-arm on idle timeouts. A receive gap ends the current cycle visibly; inspect it before looping again. A source limitation must not trigger an unbounded error loop.
8. Report separate readiness: local store, active consumer call, server connection, confirmed recipient, notification policy, inbound grant, source coverage and platform memory. Complete independent local work when messaging is unavailable. Neither startup nor a known recipient authorizes an extra test send.

The following direct-adapter bindings require paths in the same environment as taskctl. For remote configuration, use the bridge’s public/local binding and exact batch recipes instead. Variables below are already verified and nonsecret:

```bash
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" init
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" connect --id feishu-main --module "$SKILL_DIR/scripts/connectors/feishu.mjs" --settings-file "$SETTINGS_FILE"
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" watch --id task-updates --connector feishu-main --account "$APP_ID" --destination "$CHAT_ID" --destination-type chat_id --format card --events registered,progress,blocked,failed,completed,verification,result,execution --tasks all --initial
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" allow-inbound --id user-commands --connector feishu-main --account "$APP_ID" --tenant "$TENANT_ID" --sender "$SENDER_OPEN_ID" --destination "$CHAT_ID" --commands list,show,run,verify --tasks task-one --format card --reply-mode reply
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" start --consumer dot-active --timeout-ms 30000
```

`--tasks all` deliberately authorizes all tasks for that policy; use comma-separated task IDs for narrower disclosure/execution. Inbound `--since` defaults to registration time and is retained on identical re-registration. Do not widen it to old history without authorization. Initial subscription snapshots and `/tasks list` may disclose all selected tasks: scope the destination accordingly.

`start` initializes a missing store but does not install dependencies, create server configuration, infer policy, or start a receiver itself. Those are agent orchestration steps above. Its readiness field says only configured bindings or local-only; it is not live attestation. `--timeout-ms` is a 0–60000 ms idle wait budget, default 30000. Each connector lookup/receive is bounded to 15 seconds; each send to 75 seconds; the total cycle can include those operations and a bounded batch (default 10 sends, one scheduler request). This is an active-call loop, not an idle-dot wake-up facility or a permanent background service.

## Adapter interface and schemas

Modules are explicitly trusted local JavaScript code; never load a path supplied by an inbound message. Export `createConnector(settings)`. It returns an object with these functions:

| Method | Input | Return |
| --- | --- | --- |
| `capabilities()` | none | Capability object below; sync or Promise |
| `render(format, document)` | Explicit format and semantic document | Synchronous string for text/Markdown or JSON object for card; no I/O |
| `send(message, {signal})` | Frozen message envelope below | Normalized send result; Promise |
| `reply(message, {signal})` | Same envelope, non-null `reply_to` | Normalized send result; Promise |
| `receive({cursor, limit, signal})` | Opaque cursor or null; limit 1–1000 | Ordered durable page; Promise |

Capabilities: `{protocol_version:1,name:string,formats:("text"|"markdown"|"card")[],send:boolean,reply:boolean,receive:boolean,durable_cursor:boolean}`. Unsupported protocol versions or missing enabled methods fail closed. Adapter name is descriptive; connection ID scopes provider identities. Send and reply capability are distinct. `render` is always required; receive-only adapters can set send/reply false. Additional capability fields are ignored by the core. Formats never fall back implicitly: configure an explicitly supported format or stop the affected policy.

Policy capability requirements are based on actual effects:

| Policy | Required capabilities |
| --- | --- |
| `watch` | `send` and the selected output format |
| Inbound `run`, `verify`, or both, with no `list`/`show` | `receive` and `durable_cursor` only |
| Inbound including `list`/`show`, `--reply-mode reply` | `receive`, `durable_cursor`, `reply` and the selected output format |
| Inbound including `list`/`show`, `--reply-mode send` | `receive`, `durable_cursor`, `send` and the selected output format |

Receive-only adapters can declare `send:false`, `reply:false`, `formats:[]` and omit the send/reply methods. They still provide the protocol's render method, which dispatch-only policies never call. For `run`/`verify` grants, `reply_mode` and `format` are stored policy fields but create no response and impose no outbound capability requirement. They must still be recognized option values. Adding `list` or `show` requires a new immutable grant with the appropriate outbound capability and format; it cannot silently turn on unsupported messaging. Reply-only transports do not need `send` for a reply-mode response. Independent watches always require send support.

The `receive_only` scenario in [interface-examples.json](../tests/interface-examples.json) registers a no-send/no-reply/no-format adapter, accepts a run-only grant in send mode and a verify-only grant in default reply mode, ingests both synthetic commands, and asserts two scheduler requests with no outbox or outbound calls. The executable test supplies only private temporary paths and fabricated identities.

```bash
# The adapter is already connected and this exact inbound scope is authorized.
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" allow-inbound --id receive-work --connector receive-only --account "$ACCOUNT_ID" --tenant "$TENANT_ID" --sender "$SENDER_ID" --destination "$DESTINATION_ID" --commands run,verify --tasks task-one --reply-mode send
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" ingest --connector receive-only --limit 100
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" queue
```

Semantic document: `{title:string,updated_at:ISO timestamp,columns:[Title,Status,Summary],rows:string[][],details:string[]}`. Preserve task language. Text/Markdown render as lines, not a pipe table. Feishu card rendering uses JSON 1.0 native weighted columns and plain text fields so task content cannot become a mention or executable card action. A requested format is recorded before enqueue; rendered bytes freeze before the first external call. The rendered JSON serialization is limited to 28,000 UTF-8 bytes; oversized output fails locally without truncating evidence or sending a partial message. Review/narrow scope, rather than silently dropping rows.

Send/reply envelope: `{account_id:string,destination:{id:string,type:string},format:"text"|"markdown"|"card",body:string|object,reply_to:string|null,idempotency_key:string}`. `reply_to` is the actual original provider message ID. Body, account, destination/type, format, reply target, connector binding and key remain identical across retries. The Feishu adapter checks the pinned account and sends `--expected-app-id`/`--expected-brand` to the server so a replaced config cannot silently retarget an attempt. Transport settings accept only paths and nonsecret identity; custom adapters must impose an equivalent nonsecret schema and keep secrets in their transport.

Send results echo `idempotency_key` and one status:

| Status | Meaning | Automatic retry |
| --- | --- | --- |
| `api_accepted` | Requires actual nonempty `message_id`; provider accepted | Never; does not mean human read |
| `not_sent` | Adapter establishes this attempt did not invoke the message API | Only `retryable:true`, within attempt bound |
| `api_error` | Definite provider/API rejection | No; explicit reason needed to retry |
| `delivery_unknown` | May have produced an effect | Never; reconcile first |

`retryable` is normalized to false except for `not_sent`. Optional numeric `code`, `http_status`, `elapsed_ms` and allowlisted-token `error_code`, `request_phase` are retained. Raw exceptions/HTTP bodies/headers are dropped. Missing JSON, malformed status, mismatched key, invalid message ID, timeout, abort or exception after send intent becomes `delivery_unknown`; it is never converted to safe failure. The built-in adapter only marks authentication no-send failures with `ECONNABORTED`, `ETIMEDOUT`, `EAI_AGAIN`, or `ECONNRESET` as automatically retryable. The server itself never retries.

Receive page: `{events:Event[],next_cursor:string,has_more:boolean}`. Event fields: `{cursor,event_id,message_id,account_id,tenant_id,sender_tenant_id,sender_id,destination_id,type,received_at,occurred_at?,text?}`. Identity/cursor fields are nonempty single-line strings; `received_at` is an ISO timestamp, `text` is untrusted data. Missing sender or invalid time denies authorization. When the provider supplies creation time, the adapter includes `occurred_at`; both it and receive time must meet the grant cutoff. The Feishu adapter rejects command authorization when provider creation time is absent/invalid, so old messages delivered after startup cannot bypass the cutoff. Other adapters without a provider creation timestamp use their durable receive time and must disclose that limit. Events are in durable storage order, not event-time order. Each event cursor advances; the final page cursor equals the last event cursor. An empty initial stream may return its first cursor; an empty page must not advance an existing cursor. Validate a whole page envelope before committing any event. Adapters must preserve the same stream across restart and reject rotation/gaps, never reset silently. Oversized/malformed pages do not advance a checkpoint.

The machine-readable envelope definitions are [connector-protocol.schema.json](connector-protocol.schema.json). [interface-examples.json](../tests/interface-examples.json) is an executable synthetic CLI transcript run by `interface-examples.test.mjs`; no credentials or external calls are needed.

## Durable ordering, identities and recovery

Optional `integration.json` uses schema 1 and arrays `connections`, `watches`, `grants`, `outbox`, `inbox`, `checkpoints`. Existing schema-1 task stores without it remain valid. All writes use the existing process lock, fsync/atomic rename and `.transaction.json` recovery; unknown journal paths are rejected. Keep stores on a local filesystem. No automatic retention/pruning is implemented: preserve queue/inbox dedup state and backup it consistently.

A connection records `{id,module,settings,module_sha256,capabilities,binding,enabled}`. `binding` is SHA-256 of the canonical registration fields except binding/enabled. `module_sha256` pins the adapter entry file; transitive modules and server installation are trusted deployment dependencies, not a sandbox. Review a full installation upgrade; do not mutate executable dependencies during active delivery. Policy IDs are unique across watches/grants and immutable apart from enabled status. Stable notification ID/key is `notice-` plus 40 hex characters from SHA-256 of event identity and immutable route. Task event identity is `task:TASK_ID:REVISION`; initial identity is `initial:WATCH_ID`; inbound response identity is scoped message hash. Route records connector ID/binding, policy ID, account, destination/type and format; document and reply target are stored with the notification.

For task mutations, semantic comparison excludes revision-only writes, routine notes, polling timestamps and repeated unchanged observations. Meaningful title/goal/status/progress, blockers, steps, current checks, results and execution changes create one notice per matching watch/destination. Multiple matching watches are explicit separate subscriptions. Task and outbox snapshot are committed in the same journal before any network call. New inbound schedule, authorization outcome, source dedup IDs and checkpoint likewise commit in one journal. Task completion checks are never bypassed by a notification receipt.

Outbox sequence:

1. `pending`: durable queued document, route and key; available time and attempt bound.
2. `claimed`: exclusive token/consumer/expiry; claim increments attempts. Expired pre-send claims return pending (or dead when exhausted).
3. `sending`: frozen `wire_body` and intent committed before invoking the connector. Only the current unexpired token can begin or record. Expired send intent becomes unknown; a replacement consumer never calls send for it.
4. `recorded`: normalized receipt persisted before acknowledgement. After crash, recovery finishes acknowledgement without resending.
5. `api_accepted`, `api_error`, `delivery_unknown`, `dead`, or `cancelled`: visible final delivery outcome. Proven retryable no-send instead returns pending with exponential delay (2s, 4s, capped at 60s; default three attempts). Disabling a policy/connection cancels still-pending entries. Disabling cannot revoke an external call already in flight.

Default delivery lease is 120 seconds, maximum one hour. A shorter lease can expire during I/O and leave unknown delivery; never treat it as a safe retry. A stale process can still finish an external call, but its stale token cannot rewrite current state. Always establish that an old sender can no longer act before resolving an unknown attempt as no-send. No exactly-once external-delivery guarantee is made; the system offers durable dedup, conservative recovery and stable provider idempotency keys, subject to the provider's finite dedup window.

```bash
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" outbox --all
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" deliver --consumer dot-active --limit 10
# Only after authoritative evidence of API acceptance:
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" resolve-notice "$NOTICE_ID" --status api_accepted --message-id "$ACTUAL_MESSAGE_ID" --evidence "$EVIDENCE_REF"
# Or after proof of no send AND the old sender cannot act:
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" resolve-notice "$NOTICE_ID" --status not_sent --evidence "$EVIDENCE_REF"
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" retry-notice "$NOTICE_ID" --reason "$AUTHORIZED_RETRY_REASON"
```

Reconciliation/retry commands record evidence/reason supplied by the authorized agent; they do not independently query the provider or establish that evidence. Never invent a message ID or resolve from missing/partial query results. Uncertain delivery remains visible in the existing three-column task UI. Delivery receipts do not create task change events, preventing notification feedback loops.

## Inbound command authorization

Only exact text commands are recognized: `/tasks list`, `/tasks show TASK_ID`, `/tasks run TASK_ID`, `/tasks verify TASK_ID CHECK_NAME`. Whitespace around the whole message is ignored; embedded newlines, extra arguments, attachments, ordinary text and shell/instruction prefixes are rejected. Task IDs follow the existing lowercase identifier rule. Check name is an opaque exact acceptance-check label, never a script or a new instruction. Dot still checks it against the user's acceptance scope before executing a tool.

Match an enabled grant on connector, account, tenant, sender's tenant, sender ID, destination ID, command verb, task scope and `since` cutoff. Verify all these from trusted user authorization/identity evidence before registering the grant. Content cannot create a grant, expand scope or change a binding. `/tasks list` filters disclosure to the grant's task scope. `show` and `list` queue only the requested scoped response; `run` and `verify` queue execution requests and do not execute platform work. Run requires queued/executing status; verify requires awaiting_verification. Unknown/unready tasks produce a persisted rejection, not an infinite poison-message retry.

Dedup identities hash `(connector ID, account, tenant, message ID)` and independently the event ID; provider-ID collisions across adapters/accounts/tenants do not merge. The scheduler's source reference uses this scoped hash. Checkpoint CAS under the task lock prevents competing readers from skipping each other. Failed consumers reread from the last committed cursor. Out-of-order event timestamps do not reorder storage or lose authorized records. Received raw message bodies stay in the server inbox; rejected commands store only scoped hash and reason. Grants and notification snapshots contain private identifiers/task text: use private local storage and do not export them.

The Feishu adapter strips only mention keys verified by the receiver as this bot's identity. It does not strip arbitrary mention text or trust a claimed identity in message content. The server's private/group-mention receipt scope and the task grant are independent filters. Do not authorize the bot's own sender ID. Notifications are not parsed as actions and cannot self-register more work.

```bash
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" ingest --connector feishu-main --limit 100
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" inbound
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" queue
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" deny-inbound user-commands
node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR" unwatch task-updates
```

## Add another adapter

Implement the module interface above using the new transport's real API/CLI. Keep its configuration/credentials in that transport; register only nonsecret pointers. Return protocol 1 capability flags honestly, emit precise no-send versus uncertain results, propagate abort signals, and never implement an internal send retry. Use durable provider/cursor identities, scoped sender/tenant metadata and strict page ordering. Provider name is not a dedup namespace; unique connection IDs are. Run the same synthetic conformance/crash/lease/identity tests, then register a new immutable connection and explicitly authorized policies. Do not infer permission from installing an adapter.

Local tests prove transaction/recovery behavior and mocked transport payloads, not live Feishu formatting, receipt, permissions, complete task discovery, dot uptime or real platform execution. The latter require separate authorized end-to-end acceptance.

## Remote operation boundary

A remote configuration path must never be passed to the direct Feishu adapter running on dot. The bridge adapter on dot writes durable jobs and waits; the active agent sends exact batches to a reused verified local task, imports complete receipts, and resumes the original tool session. It preserves notification IDs/keys and task-ledger authority. A late accepted receipt reconciles the existing unknown notice with its real message ID, without redispatch. Task ingestion still has a 15-second bound: preserve checkpoints on timeout and report persistent transport latency. Resolve the complete bridge from the catalog, combined export, or [repository](https://github.com/fansenze/dot-skills). No credential transfer, new endpoint, generalized file access or idle-dot wake-up is added.
