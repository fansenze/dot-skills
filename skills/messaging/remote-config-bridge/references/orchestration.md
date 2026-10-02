# Agent orchestration: configuration stays on its computer

This skill transports remote operation batches and results. It does not transfer arbitrary file bytes and does not replace upload/download tools. The selected configuration and credentials stay on their original computer. Supported jobs are only `send`, `reply` and bounded `receive`; no read-file, export-file, shell or credential-transfer operation exists. Reviewed code distribution may still require supported file transfer or official Library materialization. Transfer code only, using that mechanism's own authorization and byte verification. Do not put the configuration into Library.

The agent performs the steps below. These are operational recipes, not an SDK or a new platform API. Inspect the currently exposed environment/task tool schemas and use actual returned IDs. `cloud_threads.create`, `cloud_threads.send_message` and `cloud_threads.read` are calls by the active dot; Node never invokes them. If they are unavailable, report remote orchestration unavailable and retain local task work. Do not substitute a cloud process that tries to open the user's computer path.

## Route once and reuse

| Configuration ownership | Execution route |
| --- | --- |
| User computer, orchestrated by dot in another environment | Invoke this bridge; execute all configuration and Feishu commands in one verified task on that computer |
| Configuration already in the same environment as the invoking agent | Use the Feishu local CLI directly in that environment |
| Computer/environment ownership unresolved | Resolve the selected computer; a path string alone does not identify an environment |

The Feishu skill delegates remote orchestration here once. The local task invokes Feishu's CLI, not the Feishu setup skill, so there is no recursive delegation. The bridge never calls its own skill through the worker. A request for configuration does not authorize sending, recipient discovery beyond existing permissions, or a notification subscription. Carry existing exact startup, content, destination and task-scope authorization forward; ask only for missing information. Do not repeat a permission prompt or scan unrelated files to classify secrets.

One-prompt example, assuming the referenced computer, configuration and recipient are already selected:

```text
Connect my existing Feishu configuration on the selected computer using
remote-config-bridge. Keep the configuration and credentials there. Reuse the
matching local task and receiver; start the receiver if it is not running.
Connect Manage Dot Tasks on dot to this bridge. Send the already-authorized
meaningful task updates only to my previously verified private chat, within
the agreed task scope. Reuse existing authorization and report only missing
configuration, recipient, permission or scope information. Report worker,
receiver and notification readiness separately.
```

For configuration-only requests, perform check/identity/capabilities and binding, then report readiness without a send or listener startup. If the user asks only to reuse a same-environment file, do that directly; remote bridging is unnecessary.

## Bootstrap on the selected computer

1. Dot discovers the authorized computer using actual available environment tools. Inspect the prior verified child task ID and binding when present; use `cloud_threads.read` to confirm its selected environment and current state. Reuse a matching task/store. Otherwise call `cloud_threads.create` for that actual environment with the bounded setup instruction below. Retain its returned task ID; never invent one or create a task per message.
2. The selected local task locates the complete installed bridge and Feishu packages. Their repository paths are `skills/messaging/remote-config-bridge` and `skills/messaging/feishu-message-server`; a combined archive contains those skill directories as siblings. Standalone users resolve the complete companion from the installed skill catalog or the [repository](https://github.com/fansenze/dot-skills). If the catalog is incomplete, inspect relevant `.agents/skills` in the authorized repository. Keep scripts/references/tests together. Install Feishu dependencies locally only when missing; the bridge requires none.
3. Reuse the exact selected configuration and receiver-state paths on that computer. In the local task run `check`, `identity` and `capabilities` below. Do not call `prepare`/`init` for an already usable file. If configuration is incomplete, report only missing key names and let the user complete it on that computer; do not request its secret in dot chat. For an explicitly requested local preparation, use Feishu's `prepare` locally and preserve that runtime file's needed lifetime.
4. Require protocol 1 with text/Markdown/card, send, reply, receive and durable cursor support before using this adapter. Its declared capabilities describe that verified server contract, not live connectivity. Confirm the selected app ID and brand. Compute the actual server entry-point hash locally. Keep the entire reviewed installation/dependencies trusted; this hash does not cover imports.
5. Write the private local binding outside reusable code, initialize/reuse the local store, and return only the public binding plus concise readiness/evidence references. The local configuration path is not part of the public binding. Do not return configuration contents, raw stderr, environment dumps or secrets.
6. If receiver startup is authorized, inspect/reuse its actual matching process/session, configuration and state directory. Otherwise start the foreground receiver in a supported local process session and retain that session. Wait for current lifecycle evidence. Do not start a second receiver or send a probe just to improve the report.

Local task instruction template:

```text
Work only on the already selected computer. Reuse the selected Feishu config,
state directory and matching receiver. Locate the installed bridge and actual
Feishu scripts/server.mjs. Invoke its local CLI directly; do not invoke either
setup skill recursively. Check required configuration, return nonsecret identity
and capabilities, hash the server entry point, and initialize/reuse the private
worker binding/store. Perform startup only if the enclosing request authorized
it. Return the public binding and separate worker/connection/recipient readiness.
Do not copy credentials to dot, expose a port, or send a test message.
```

Commands executed **only by the local task** (variables denote verified local paths):

```bash
node "$LOCAL_SERVER" check --config "$LOCAL_CONFIG"
node "$LOCAL_SERVER" identity --config "$LOCAL_CONFIG"
node "$LOCAL_SERVER" capabilities
node "$LOCAL_BRIDGE/scripts/bridge.mjs" hash --file "$LOCAL_SERVER"
node "$LOCAL_BRIDGE/scripts/bridge.mjs" init-local --store "$LOCAL_STORE" --binding "$LOCAL_BINDING_JSON"
# Only for already-authorized startup when no matching receiver is running:
node "$LOCAL_SERVER" start --config "$LOCAL_CONFIG" --state-dir "$LOCAL_RECEIVER_STATE"
```

Private local JSON: `{remote_id,account_id,brand,server_sha256,server,config_ref,state_dir}`. Public JSON: `{remote_id,account_id,brand,server_sha256}`. IDs and hash come from the verified setup result. Persist JSON with a private file-writing tool, never by interpolating values into shell code. The separate worker store retains send intent/receipts across upgrades and replay; do not initialize a new empty store to evade uncertain delivery. Changing an immutable binding needs deliberate review, leaving old unresolved jobs intact.

## Bind the dot task consumer

Dot stores only the public binding, actual verified task ID, batch jobs and receipts. Its task ledger continues to own notification subscriptions, inbound grants and completion checks. On dot:

```bash
node "$DOT_BRIDGE/scripts/bridge.mjs" init-cloud --store "$CLOUD_BRIDGE_STORE" --binding "$PUBLIC_BINDING_JSON" --thread-id "$VERIFIED_LOCAL_TASK_ID"
node "$TASK_SKILL/scripts/taskctl.mjs" --store "$TASK_STORE" connect --id remote-feishu --module "$DOT_BRIDGE/scripts/adapter.mjs" --settings-file "$BRIDGE_SETTINGS_JSON"
```

Settings contain exactly `{"store":"/absolute/dot/bridge-store","authorization_ref":"actual-user-authorization-reference"}`. They contain no remote configuration path. Do not register `manage-dot-tasks/scripts/connectors/feishu.mjs` with a Mac configuration path on dot; that direct adapter spawns a CLI in its own environment. Continue with the task skill's real `watch`/`allow-inbound` commands for only the authorized destinations and task scope. Binding creation alone neither sends nor grants inbox command authority.

## Exact batch and receipt flow

1. Dot starts one bounded task operation (for example `deliver --consumer dot-active --limit 1` or an authorized `ingest`). Use the environment's actual early-yield/session option so dot can transport jobs while the adapter waits. Retain the process handle and collect its final output. Do not detach it and claim monitoring. The adapter durably enqueues before waiting.
2. Dot runs `export --limit 1` below. Read that exact bounded JSON file using the current environment's file tool. Use the same verified local task ID with `cloud_threads.send_message` to deliver the JSON as data plus the fixed processing instruction. The input is a bridge batch, not a shell script. If a message channel truncates/limits it, use an authorized code/data transfer mechanism and verify exact JSON bytes; never split, truncate, summarize, or add credentials to the batch.
3. The reused local task saves the exact JSON privately, then runs only `process --store FIXED_LOCAL_STORE`. No job can change executable/config/state bindings or include shell commands. `process` records intent before the local CLI call and receipt before returning.
4. Dot uses `cloud_threads.read` on that same task, retrieves the complete receipt bundle from its reported output/file, and verifies that it belongs to the expected task/binding. A completed task turn alone is not a receipt. If output is missing or truncated, retrieve the existing receipt file or replay the exact batch; do not enqueue a new send. Hashes are consistency checks, not proof of an arbitrary sender's identity.
5. Dot writes and imports the complete bundle, then resumes/reads the original waiting task operation. Its normal record/ack semantics still apply. The local worker serializes batches under its lock; a busy result is not permission to reset a send intent or start a second worker. Use small batches within lease/time budgets.

```bash
# Dot, while the original task operation is waiting:
node "$DOT_BRIDGE/scripts/bridge.mjs" export --store "$CLOUD_BRIDGE_STORE" --output "$DOT_BATCH_JSON" --limit 1
# Local task, after actual cloud_threads.send_message delivery:
node "$LOCAL_BRIDGE/scripts/bridge.mjs" process --store "$LOCAL_STORE" --input "$LOCAL_BATCH_JSON" --output "$LOCAL_RECEIPTS_JSON"
# Dot, after actual cloud_threads.read returns the complete verified bundle:
node "$DOT_BRIDGE/scripts/bridge.mjs" import --store "$CLOUD_BRIDGE_STORE" --input "$DOT_RECEIPTS_JSON"
```

[orchestration-example.json](orchestration-example.json) is an executable synthetic transcript: local check/identity/capabilities and binding, cloud binding reuse, bounded batch export, simulated platform message/read boundaries, exact receipt import and replay. `tests/orchestration.test.mjs` executes the CLI steps against isolated fake computers and fails if local configuration paths appear in a cloud CLI step, a remote step invokes a setup skill recursively, or replay produces another fixture effect. Platform steps are typed orchestration instructions, **not** literal API parameter schemas; the active agent maps them to currently exposed tools. The test never calls platform tools or a real network.

## Late results and readiness

The bridge adapter waits up to 65 seconds. Task delivery has a 75-second bound; task inbox ingestion has a shorter 15-second bound. Remote transport may outlast either. Pending jobs and receipts persist. Continue fetching/importing the same send receipt even if the waiting operation has ended. With authoritative `api_accepted`, reconcile the existing `delivery_unknown` notice using `taskctl resolve-notice NOTICE_ID --status api_accepted --message-id ACTUAL_ID --evidence RECEIPT_REF`. If it is still leased/sending, first collect the original operation or recover its expired lease under the task protocol. A late receipt must not trigger another dispatch or an invented task completion.

Without conclusive delivery evidence, keep uncertainty. The bridge has no retry/reset operation for send intent; do not work around it with a new key. For inbox reads, leave the task checkpoint unchanged on timeout/error. Import a late page as bridge evidence, then use a new polling occurrence at that unchanged cursor; replay of the old receive job intentionally returns its previous page. Do not manually advance task checkpoints from a late or partial page. If transport repeatedly exceeds the ingest bound, report that limitation; do not claim healthy continuous ingestion or silently change timeouts.

Report worker binding, local receiver connection, verified receipt, send API acceptance and human reading separately. `listener_starting`, a process ID, an initialized bridge or a completed local task is not `transport_connected`. Use only current lifecycle evidence with no later disconnect/stop. A known recipient does not establish live send permission. This workflow depends on active dot calls and available local execution; it cannot wake an inactive dot or keep an offline computer running.
