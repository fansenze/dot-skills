# Service location and configuration routing

Select the Feishu service host from the user's explicit request or a previously verified selection. Configuration source location does not choose the service host. Task execution and ledger location are separate choices. If the service host is unclear, ask before starting a receiver. Do not start a service on a source-only Mac, or silently move the ledger there. The table below assumes task management on dot; standalone hosting in the invoking agent's own environment remains direct and needs no remote worker.

| Requested service host | Configuration evidence | Next action |
| --- | --- | --- |
| dot | Already readable on dot | Direct CLI and direct task adapter on dot; no local worker |
| dot | Configuration exists on a connected computer | Transfer the selected configuration through the internal Library skill, verify its exact bytes on dot, then use the actual dot-local path for direct setup |
| Connected computer explicitly selected | Host-local configuration | Bridge route below; configuration and transport stay on that host, ledger stays on dot |
| Not selected | Any source path | Clarify service host; a path alone is insufficient |

## Configuration transfer through Library

The user's request to use a selected configuration for a service on dot authorizes this transfer. Carry that authorization forward without another confirmation.

1. Read the current `orbit:remote-environments` and `openai-library:library` skills. Use the actual environment/task tools to select the named computer and create or reuse its local executor task for the exact source path.
2. Have that local task read the selected file only for upload and integrity hashing. Preserve its bytes without inspecting, parsing, classifying or changing its contents. Upload through the current internal Library skill and return the confirmed Library identity, filename, source byte count and SHA-256. Keep the source file unchanged.
3. On dot, materialize that confirmed upload using the current Library skill and its materialization reference. Verify that the resulting path is readable on dot and that its byte count and SHA-256 match the producer's result. Reuse an already confirmed transfer when resuming.
4. Set `SERVICE_CONFIG` to that verified dot-local file and continue the checks and authorized startup below. Configuration parsing belongs to the Feishu CLI after transfer.

## Verify runtime tools

Before setup/reuse, compare the actual installed files with the requested repository revision or trusted export manifest. Skill names and package version strings alone cannot identify an old installation. Pin the verified absolute `FEISHU_SKILL` root and, where needed, task and bridge roots. Use the same roots for checks, dependency setup, startup and later operations, regardless of the shell's working directory. Do not read current instructions and execute stale default scripts. If an update is required, resolve it through the supported installation workflow before activation and preserve existing runtime state and receipts; do not silently replace an active binding or start a duplicate receiver.

Use Node.js 22.18+ and pnpm 11.27.0. Resolve `PNPM_BIN` to the verified pnpm installation's `node_modules/.bin` directory (or its verified shim directory), then prepend it to `PATH` for the whole operation and its children. Calling `node /path/to/pnpm.cjs` only pins the parent invocation: child scripts can still find an older pnpm. Verify the child lookup too. Pass this same `PATH` in each later tool execution; a shell export does not persist across independent tool calls.

<!-- runtime-toolchain-check -->
```bash
: "${PNPM_BIN:?Set the verified pnpm 11.27.0 bin directory}"
export PATH="$PNPM_BIN:$PATH"
pnpm --version
node -e 'const {execFileSync} = require("node:child_process"); const v = execFileSync("pnpm", ["--version"], {encoding: "utf8"}).trim(); if (v !== "11.27.0") throw new Error("Expected pnpm 11.27.0 in child PATH; got " + v); console.log(v);'
```

Stop setup on a version mismatch. Install dependencies using that verified environment only when missing; use the same environment for package scripts and validation.

## Service on dot

Proceed only after the selected dot runtime is verified and `SERVICE_CONFIG` is an actual readable dot-local path. A Mac path or successful producer-side action is not that evidence. The commands below inspect configuration without a network request; stop on any failed check. Do not fall back to a Mac configuration or older installation.

<!-- dot-service-checks -->
```bash
node "$FEISHU_SKILL/scripts/server.mjs" check --config "$SERVICE_CONFIG"
node "$FEISHU_SKILL/scripts/server.mjs" identity --config "$SERVICE_CONFIG"
node "$FEISHU_SKILL/scripts/server.mjs" capabilities
```

Configure Manage Dot Tasks' direct `scripts/connectors/feishu.mjs` adapter with the verified dot-local `server`, `config_ref`, `state_dir`, `account_id` and `brand`. Keep secrets out of settings and the ledger. Only under existing startup authorization, reuse a matching receiver or call the same pinned server with `start --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE"`. Do not claim connection until current `transport_connected`/`transport_reconnected` evidence exists. Configuration readiness does not authorize a recipient or outgoing probe.

## Explicit computer hosting

Only this route invokes `remote-config-bridge`. It carries operation batches and receipts, not arbitrary files. The user must have selected the computer as the service host; a configuration source path alone is not that choice. Keep its configuration, credentials and transport there. The following local/dot commands are confined to this bridge route.

Resolve the complete bridge through the installed catalog, the combined export's sibling `remote-config-bridge`, or `skills/messaging/remote-config-bridge` in the [repository](https://github.com/fansenze/dot-skills). If relevant catalog entries are missing, check the authorized checkout's `.agents/skills`. Read its `SKILL.md`, `references/orchestration.md` and executable `references/orchestration-example.json`. A standalone Feishu archive contains this recipe; it does not pretend the companion is installed. If tools/code are unavailable, report the actual gap and continue independent local task work.

## One request, one reused task

Example request:

```text
Host the Feishu service on my selected connected computer, with task management
on dot through remote-config-bridge. Reuse the verified local task and existing
receiver, or start the receiver under this request if needed. Connect dot's
task notifications only to the already-authorized, verified destination and
scope. Report missing recipient/permission/scope facts without repeating my
existing authorization. Do not send a diagnostic message.
```

A configuration-only request does not authorize startup or a message. A path alone does not identify a computer, recipient or permission. Resolve only missing facts; do not scan unrelated files or request secrets in dot chat.

1. **Dot:** use the actual environment tools to identify the selected computer. Reuse the matching verified child task ID/store and confirm it via `cloud_threads.read`. If absent, call actual `cloud_threads.create` on that environment, then retain the returned ID. Inspect current tool schemas; these tool names are not APIs called by Node.
2. **Selected local task:** verify the requested revision, pin `LOCAL_SERVER` and `LOCAL_BRIDGE`, and invoke the local CLI commands below from those roots. Reuse the selected configuration directly; no `prepare`/`init` for a usable existing file. Run dependency setup locally only when needed, with the verified pnpm on `PATH` for child processes too. Return only safe identity/capabilities, the server entry hash and readiness. Missing configuration is completed on that computer.
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
