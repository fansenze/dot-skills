# Remote configuration routing

When dot orchestrates a configuration on the user's computer, invoke `remote-config-bridge` once. Keep the selected file, credentials and Feishu transport on that computer. This is remote operation/batch transport, not a generic file bridge or replacement for upload/download tools. Code distribution may use a supported file mechanism; do not upload the configuration to Library. Same-environment/local-only configuration uses the Feishu CLI directly in that environment.

Resolve the complete bridge through the installed catalog, the combined export's sibling `remote-config-bridge`, or `skills/messaging/remote-config-bridge` in the [repository](https://github.com/fansenze/dot-skills). If relevant catalog entries are missing, check the authorized checkout's `.agents/skills`. Read its `SKILL.md`, `references/orchestration.md` and executable `references/orchestration-example.json`. A standalone Feishu archive contains this recipe; it does not pretend the companion is installed. If tools/code are unavailable, report the actual gap and continue independent local task work.

## One request, one reused task

Example request:

```text
Connect my existing Feishu configuration on the selected computer. Keep it
there and use remote-config-bridge. Reuse the verified local task and existing
receiver, or start the receiver under this request if needed. Connect dot's
task notifications only to the already-authorized, verified destination and
scope. Report missing recipient/permission/scope facts without repeating my
existing authorization. Do not send a diagnostic message.
```

A configuration-only request does not authorize startup or a message. A path alone does not identify a computer, recipient or permission. Resolve only missing facts; do not scan unrelated files or request secrets in dot chat.

1. **Dot:** use the actual environment tools to identify the selected computer. Reuse the matching verified child task ID/store and confirm it via `cloud_threads.read`. If absent, call actual `cloud_threads.create` on that environment, then retain the returned ID. Inspect current tool schemas; these tool names are not APIs called by Node.
2. **Selected local task:** invoke the local CLI commands below. Reuse the selected configuration directly; no `prepare`/`init` for a usable existing file. Run dependency setup locally only when needed. Return only safe identity/capabilities, the server entry hash and readiness. Missing configuration is completed on that computer.
3. **Selected local task:** create/reuse its private bridge binding/store with actual `server`, `config_ref` and `state_dir` paths. Return only public `remote_id`, `account_id`, `brand`, `server_sha256`. If startup is authorized, reuse or start the matching receiver and retain its process/session evidence. The worker invokes CLI commands directly; it must not call the Feishu setup skill or bridge skill recursively.
4. **Dot:** initialize/reuse the cloud bridge store with that public binding and actual task ID. Register the bridge adapter with the task ledger. The direct Feishu adapter is for same-environment paths only; never give a cloud-local spawn a Mac configuration path.
5. **Dot:** use task subscriptions/grants only for the existing authorized recipient and scope, then run the bounded active transport cycle below. Keep configuration readiness, worker binding, receiver connection and notification authorization separate.

Local task only:

```bash
node "$LOCAL_SERVER" check --config "$LOCAL_CONFIG"
node "$LOCAL_SERVER" identity --config "$LOCAL_CONFIG"
node "$LOCAL_SERVER" capabilities
node "$LOCAL_BRIDGE/scripts/bridge.mjs" hash --file "$LOCAL_SERVER"
node "$LOCAL_BRIDGE/scripts/bridge.mjs" init-local --store "$LOCAL_STORE" --binding "$LOCAL_BINDING_JSON"
# Only when authorized and no matching receiver is running:
node "$LOCAL_SERVER" start --config "$LOCAL_CONFIG" --state-dir "$LOCAL_STATE"
```

Dot only:

```bash
node "$DOT_BRIDGE/scripts/bridge.mjs" init-cloud --store "$CLOUD_BRIDGE_STORE" --binding "$PUBLIC_BINDING_JSON" --thread-id "$VERIFIED_LOCAL_TASK_ID"
node "$TASK_SKILL/scripts/taskctl.mjs" --store "$TASK_STORE" connect --id remote-feishu --module "$DOT_BRIDGE/scripts/adapter.mjs" --settings-file "$BRIDGE_SETTINGS_JSON"
```

Cloud settings contain only `store` and `authorization_ref`. The authorization reference points to the actual agreed operation scope. Private JSON files are written with file tools, not interpolated shell text. The bridge initialization commands reject silent rebinding and reuse identical stores. Preserve previous job/receipt state and the accepted locking/recovery behavior across code updates.

## Bounded operation and result flow

Start the task delivery/ingest operation using an actual early-yield process session, retain its handle, and transport while it waits. Dot exports a small batch; `cloud_threads.send_message` sends its exact JSON to the same verified task. The local task writes that data privately and processes it with its fixed worker binding. Dot uses `cloud_threads.read` to retrieve the complete receipt bundle, imports it, then collects the original waiting operation's final output. Do not confuse a task turn finishing with API acceptance.

```bash
# Dot:
node "$DOT_BRIDGE/scripts/bridge.mjs" export --store "$CLOUD_BRIDGE_STORE" --output "$DOT_BATCH_JSON" --limit 1
# Local task after the verified task-message boundary:
node "$LOCAL_BRIDGE/scripts/bridge.mjs" process --store "$LOCAL_STORE" --input "$LOCAL_BATCH_JSON" --output "$LOCAL_RECEIPTS_JSON"
# Dot after retrieving the complete verified receipt bundle:
node "$DOT_BRIDGE/scripts/bridge.mjs" import --store "$CLOUD_BRIDGE_STORE" --input "$DOT_RECEIPTS_JSON"
```

Supported jobs are only `send`, `reply` and bounded `receive`. No job reads arbitrary files or transports secrets. Do not summarize/truncate a batch or receipt. If the task-message boundary cannot carry it, use an authorized transfer for only the bounded data file and verify bytes; never create a public endpoint or credential upload as a fallback. Bindings and hashes must match, and receipts must come from the verified task; a checksum alone does not authenticate an arbitrary message.

A lost task result or timeout does not authorize redispatch. Read the same local result or replay the exact batch, which returns its saved receipt. Preserve the original key/body/recipient. A late successful receipt reconciles the existing unknown notice through the task skill's `resolve-notice` with real message ID/evidence. Keep unknown results unknown otherwise. Receive timeouts leave the task checkpoint unchanged; a new polling occurrence can reread from that cursor. Repeated latency beyond the task ingest bound must be reported instead of claiming healthy ingestion.

Current bridge wait is 65 seconds; task delivery is bounded to 75 seconds and task ingestion to 15 seconds. The active agent must pump task messages while operations wait and collect yielded sessions. This is not an idle-dot wake-up mechanism. `listener_starting`, a PID or a bound worker is not connection readiness: use current `transport_connected`/`transport_reconnected` evidence without later disconnect/stop. API acceptance does not prove human reading. Prior synthetic cross-machine operation/replay acceptance does not prove live Feishu delivery or bypass a network policy denial.
