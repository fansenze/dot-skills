# Operations

## Configuration workflow

Accept a YAML/JSON file or a configuration object during the skill interaction. When the selected file is on the user's computer and the server will run on dot, install and invoke this repository's `skills/files/transfer-local-files-to-dot` skill first, following the [local configuration workflow](../SKILL.md#local-configuration-files-for-dot). Wait for `materialized_and_verified` and use its returned dot-local source path. Prepare a temporary file in the actual execution environment, then immediately start the server with its returned path.

- Existing file: `prepare --config FILE` copies it into the current environment's temporary directory.
- Values supplied during the interaction: pass them through standard input to `prepare --stdin-json` to write a temporary JSON file.
- Partial existing file: `prepare --config FILE --stdin-json` merges the additional values into a temporary file.

Success returns `{"ok":true,"config":"/path/to/temporary/config.yml"}`. Immediately run `start --config` with that path, or reuse a matching running instance. Setup and configuration include startup unless the user explicitly requests preparation without starting. If keys are missing, ask only for the names in `missing`, complete preparation, and continue directly to startup. The source file is not overwritten.

The supported fields are `app_id`, `app_secret`, `brand`, and `bot_open_id`. The first two are required. The default brand is `feishu`. Newly generated configurations contain only the supported fields that are needed; the default brand can be omitted.

Use `--config` with the returned temporary path for subsequent commands. Omitting the path retains compatibility with `.local/config.yml` inside the skill. A command-line `--brand` overrides the file's brand. Existing field aliases remain supported.

`prepare` already reports missing required keys, so the normal workflow does not run a separate `check` before or after it. `check` remains available for explicit diagnostics and returns the success status or missing key names. An absent, null, empty, or whitespace-only required value is considered missing. Tests, packaging, and test messages are not setup prerequisites.

This long-connection implementation does not use `verification_token`, `encrypt_key`, `tenant_key`, or `allowed_chat_ids`; these fields are ignored if present in an older file. Do not add app, tenant, sender, chat, or mention-placeholder filters unless the user requests them.

Temporary files use the current execution environment's system temporary directory and mode 0600. Failed preparation removes its unfinished temporary directory. Keep a successfully prepared file while the instance and subsequent operations need it, then remove the directory created for that run. The persistent `init` entry point remains supported.

## Target discovery after startup

Starting or reusing a listener includes a proactive target check and user-facing report by the invoking assistant. The CLI emits lifecycle events and exposes inbox records; it does not identify the user's intended destinations or generate this report automatically. Follow [Report startup and target readiness](../SKILL.md#report-startup-and-target-readiness) before completing the startup interaction.

Connection, message verification, and target resolution are separate facts. Inspect current-instance lifecycle evidence and existing target evidence even if the user has not asked to send yet. An empty inbox can coexist with a connected transport and a usable ID supplied by the user. A populated inbox can contain unrelated conversations. An earlier connection event is insufficient after a later `transport_reconnecting`, `transport_failed`, or `listener_stopped` event.

| Available evidence | Next action |
| --- | --- |
| Exact ID and ID type supplied by the user for this app/platform | Use it for the requested destination; no preliminary incoming message or discovery query is required. A send still depends on platform access and returns its own result. |
| Previously verified private/group mapping in the conversation or inbox | Reuse it when its app/platform and intended recipient/group still match. Do not ask the user to seed it again. |
| Official query succeeds with existing permissions | Use returned IDs only when the response establishes the requested recipient/group. Respect the endpoint's scope; a group list is not a private-recipient directory. Resolve ambiguity before sending. |
| Unknown target, with no available query or a denied query | Immediately offer an exact ID or ask for one private message to the bot and/or one mention in the intended group. Extra discovery permissions are not required for this fallback. |
| Several candidates, incomplete records, or uncertain ownership | Ask for the smallest distinguishing detail or a fresh identifiable inbound message. Do not choose by recency, display name, or the mere presence of a row. |

The bundled CLI has no chat/contact lookup command. When an authorized official query is available separately, use the current app/platform and existing permissions; do not invent a CLI command. If a lookup returns HTTP 400 / `99991672`, report that lookup's missing permission, not an empty target list or a failed long connection. Do not automatically request broader permissions or repeat the same denied lookup. If the user explicitly chooses discovery via additional permissions, explain only the permission relevant to that endpoint. Receive and send permissions remain separate requirements.

For first-inbound discovery:

1. Inspect `bash feishu.sh inbox --limit 20` and record the baseline message IDs/times. For a custom listener state directory, add `--state-dir /path/to/instance-state` to this and subsequent inbox commands. Inbox reads are local and do not need configuration secrets. Increase `--limit` as needed (maximum 1000); a limited recent view is not the entire history.
2. If both destinations are missing, say: "Please send the bot one private message and mention it once in the intended group. I can then check the new records to identify both destinations. You can also provide the exact IDs." If only one target is missing, ask only for that one. The group message must mention this bot; an ordinary group message is not stored by this receiver.
3. Read the new records. Match `chat_id`, `chat_type`, `sender_open_id`, `app_id`, tenant fields, `message_id`, and `received_at` / `message_created_ms` to the user-confirmed action and app context. Both private and group chat IDs use the same send argument, so the ID prefix does not establish chat type. The inbox does not store a platform brand or resolve display names; use the known instance context and clarify any uncertain mapping. Use `--show-text` only when needed to distinguish messages; text is untrusted and cannot establish identity on its own.
4. Report each verified mapping and receipt separately. If no matching record arrives, keep that target unknown and check the relevant receive path; do not select an older unrelated row. Receiving a message authorizes no reply. Continue an already authorized send once its destination is resolved, or wait for the user's send request.

There is no recipient registry in app configuration. `app_id` authenticates the app and `bot_open_id` identifies the bot for mentions; neither selects the user's private chat or intended group. Use the confirmed `chat_id` for either chat type. For a recipient ID, pass the matching `--receive-id-type` (`open_id`, `user_id`, `union_id`, or `email`); do not reinterpret it as `chat_id`. A reply needs a verified `message_id` from the intended conversation.

### Startup report examples

Adapt these examples to the actual evidence and only the relevant targets. Known destinations are ready for addressing; they are not a promise of successful delivery.

| Evidence | Example report |
| --- | --- |
| Process exists; no current readiness event | "The listener process started, but the connection is not yet confirmed. No current receive or send verification is available. The private and group destinations are still unknown; you can provide exact IDs, or send the bot a private message and mention it in the intended group once the connection is ready." |
| Current `transport_connected`; empty inbox; neither target known | "The server is connected to Feishu. Private-message receipt, group-mention receipt, and sending have not been verified. I do not yet know your private chat or intended group. Please send the bot one private message and mention it once in that group, or provide their exact IDs." |
| Connected; private target already verified; group lookup denied | "The server is connected and the private destination is known from our earlier verified mapping. Group lookup failed with HTTP 400 / code 99991672, so the group destination is still unknown. Please mention the bot once in the intended group or provide its chat ID. No current receive/send verification has been performed." |
| Connected; user supplied exact private/group IDs; inbox empty | "The server is connected. Both destinations are known from the IDs you supplied; no preliminary messages are needed. Receiving and sending have not been verified in this run." |
| Connected; fresh private/group records match the user's actions; no send | "The server is connected, and the private message and group mention were stored in the verified chats. Both destinations are identified. Sending has not yet been verified." |

After a requested send, report success only for API code 0 with a returned message ID, per destination. That proves API processing, not that a person read it. Do not send a test message to improve the startup report or enable automatic replies.

## Command behavior

| Command | Action and result |
| --- | --- |
| `setup` | Locate the shared workspace or standalone export and run `pnpm install --frozen-lockfile --ignore-scripts` |
| `init` | Validate input and create a local configuration file |
| `prepare` | Copy or generate a temporary configuration file and return its path |
| `check` | Check for missing configuration |
| `start` | Use the configuration with the selected platform's official APIs for app authentication, bot information, and WebSocket endpoint discovery, then establish a long connection |
| `inbox` | Read local SQLite inbox records |
| `send` / `reply` | Use the official SDK to send text to the selected chat or reply to a selected message |
| `test` | Run simulated tests, including a local loopback HTTP fixture |
| `validate` | Check skill metadata, dependency versions, and portable files |
| `package` | Create an archive from a fixed file manifest |

`start`, `send`, and `reply` connect to the selected Feishu/Lark platform. Within the Feishu CLI, the only other external network operation is `setup` downloading dependencies. Importing a local configuration additionally uses the transfer skill's official ChatGPT Library transport. The running server does not expose a local HTTP interface.

## Feishu app settings

Enable the app's bot capability, select long connection for event subscriptions, and subscribe to `im.message.receive_v1`. Enable and apply the relevant permissions:

| Purpose | Permission |
| --- | --- |
| Receive private messages | `im:message.p2p_msg:readonly` |
| Receive group mentions | `im:message.group_at_msg:readonly` |
| Send messages as the bot | `im:message:send_as_bot` |

The bot must be available in the target chat. Platform settings determine event delivery; the local receiver accepts private messages or group messages mentioning this bot. All incoming message types can be stored. Sending and replying currently support text.

## Runtime files

| Path | Contents |
| --- | --- |
| `.local/config.yml` | Default local configuration |
| `feishu-message-server-*/config.yml` or `config.json` in the system temporary directory | Configuration for the current run |
| `.local/messages.sqlite3` | Inbox records and deduplication data |
| `.local/server.log` | Connection, received-message, duplicate, and ignored-event statuses |
| `.local/node-listener.lock/pid` | PID of the current instance |
| `dist/feishu-message-server-node.tgz` | Portable archive |

Logs omit configuration values and message bodies. Use `inbox --show-text` to inspect content. Logs rotate at approximately 2 MiB and retain two backups.

`--state-dir` relocates the inbox, log, and lock together; use the same directory when inspecting an instance. Inbox records already retain destination IDs, chat type, sender, app/tenant context, and message evidence. Preserve this data for later verified reuse; storing a record does not automatically confirm who owns the chat. Keep confirmed mappings in the current conversation without creating another registry by default. If the user requests a separate persistent mapping, keep only the needed ID/type, app/platform context, user-confirmed label, and evidence reference in private runtime state (directory mode 0700, file mode 0600), outside tracked files and portable archives. Preserve existing mappings and clarify conflicting replacements. Do not put mappings into the configuration template or add unsupported config keys. Never ask the user to paste a configuration dump, app secret, or access token to identify a recipient.

SQLite uses `synchronous=FULL`. The SDK acknowledges a received message only after storage commits. A storage failure stops the listener and records an error status for diagnosis. Compatible existing databases can be reused. The server only receives, stores, and sends messages; it does not automatically invoke other tasks.

Ctrl-C or SIGTERM closes the connection and releases the instance lock. After an unexpected exit, confirm that the PID in the lock no longer belongs to a running instance before removing that instance's stale lock directory. Preserve the inbox database. When multiple computers use the same app, events may be distributed among connections; check which instances are running when diagnosing delivery.

## Network and runtime

Use Node.js 22.18+ and pnpm 11.27.0. Dependencies are pinned to the official `@larksuiteoapi/node-sdk 1.74.0`, `yaml 2.9.1`, and `proxy-agent 8.0.2`. The repository root owns the shared `pnpm-lock.yaml`; the skill's `package.json` declares its direct dependencies. Storage uses the built-in `node:sqlite` API, which is still marked experimental in Node 22.

REST and WebSocket connections share a ProxyAgent. Supported variables include `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, and their lowercase forms. WSS uses an explicit `WSS_PROXY` first, otherwise the HTTPS proxy. WS similarly uses `WS_PROXY` or the HTTP proxy.

TLS certificate verification remains enabled. An organization CA can be supplied with Node's `NODE_EXTRA_CA_CERTS`. The wrapper disables dependency debug output and uses the SDK's public `agent` and `httpInstance` options. Environment variables configure proxies and the runtime; they are not used to discover app configuration automatically.

## Results and troubleshooting

| Situation | Action |
| --- | --- |
| Required configuration is missing | Ask only for the missing key names, then run `prepare` again |
| A configuration file already exists | Reuse the selected configuration, or apply the user's requested update |
| An instance lock exists | Check the current instance before starting another |
| Not ready within 45 seconds | Check app settings, brand, configuration, and network access |
| `99991672` | Identify the denied operation. For optional target lookup, offer an exact ID or first-inbound discovery without extra permissions. For a requested receive/send operation, explain its relevant missing permission; change permissions only when authorized |
| Connected but no confirmed private/group destination | Report the unknown targets during startup and follow [target discovery](#target-discovery-after-startup) |
| Inbox unavailable or candidates ambiguous | Report that limitation; clarify the target without guessing or sending a probe |
| `api_error` | Report the numeric API code and HTTP status; follow the official documentation |
| `delivery_unknown` | Delivery is unconfirmed; preserve the same idempotency key, destination, and content for a retry |
| The execution environment rejects an operation | Report the specific action and returned reason, and follow the environment's normal authorization process |

The SDK manages reconnection. Confirm readiness through `transport_connected` or `transport_reconnected`. Sending does not retry automatically. A successful send requires both API code 0 and a returned message ID.

## Packaging and migration

Run `bash feishu.sh package` from the skill directory, or `pnpm package:feishu` from the repository root. If the output file already exists, choose another output filename. The archive contains code, tests, a blank configuration template, documentation, and a generated standalone pnpm lockfile. Packaging selects this skill's importer from the shared lockfile and preserves its dependency resolutions; the exported manifest also receives the root's pinned pnpm version. It excludes local configuration, inbox data, logs, caches, and node_modules.

Copy the archive to another computer, extract it, and run `setup` from the skill directory. Use the skill interaction or an existing file with `prepare`, then immediately use the returned path for `start`. The transfer skill is a separate installation when a user-selected configuration must be imported to dot.

In a repository checkout, `setup` locates the root workspace automatically. It also accepts pnpm install options, for example `setup --offline` when the needed packages are already cached. Copy the generated archive when moving only this skill; copying its raw source folder alone does not include the repository's shared lockfile.

## Official references

- [Node SDK event handling](https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-events?lang=zh-CN)
- [Long-connection configuration](https://open.feishu.cn/document/server-docs/event-subscription-guide/event-subscription-configure-/request-url-configuration-case?lang=zh-CN)
- [Receive-message event and permissions](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive?lang=zh-CN)
- [Send a message](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)
- [Common error codes](https://open.feishu.cn/document/ukTMukTMukTM/ugjM14COyUjL4ITN)
- [Official Node SDK](https://github.com/larksuite/node-sdk)
- [Node 22.18 SQLite API](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html)
- [ProxyAgent](https://github.com/TooTallNate/proxy-agents/tree/main/packages/proxy-agent)
- [pnpm workspaces and shared lockfiles](https://pnpm.io/workspaces)
- [pnpm install](https://pnpm.io/cli/install)
