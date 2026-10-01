# Operations

## Configuration workflow

Accept a YAML/JSON file or a configuration object during the skill interaction. Prepare a temporary file in the actual execution environment, then pass its returned path to the scripts.

- Existing file: `prepare --config FILE` copies it into the current environment's temporary directory.
- Values supplied during the interaction: pass them through standard input to `prepare --stdin-json` to write a temporary JSON file.
- Partial existing file: `prepare --config FILE --stdin-json` merges the additional values into a temporary file.

Success returns `{"ok":true,"config":"/path/to/temporary/config.yml"}`. If keys are missing, ask only for the names in `missing`. The source file is not overwritten.

The supported fields are `app_id`, `app_secret`, `brand`, and `bot_open_id`. The first two are required. The default brand is `feishu`. Newly generated configurations contain only the supported fields that are needed; the default brand can be omitted.

Use `--config` with the returned temporary path for subsequent commands. Omitting the path retains compatibility with `.local/config.yml` inside the skill. A command-line `--brand` overrides the file's brand. Existing field aliases remain supported.

`check` checks only for missing configuration and returns the success status or missing key names. An absent, null, empty, or whitespace-only required value is considered missing.

This long-connection implementation does not use `verification_token`, `encrypt_key`, `tenant_key`, or `allowed_chat_ids`; these fields are ignored if present in an older file. Do not add app, tenant, sender, chat, or mention-placeholder filters unless the user requests them.

Temporary files use the current execution environment's system temporary directory and mode 0600. Failed preparation removes its unfinished temporary directory. Keep a successfully prepared file while the instance and subsequent operations need it, then remove the directory created for that run. The persistent `init` entry point remains supported.

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

`start`, `send`, and `reply` connect to the selected Feishu/Lark platform. The only other external network operation is `setup` downloading dependencies. The running server does not expose a local HTTP interface.

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
| `99991672` | Enable the relevant API permission in the Feishu console, apply it, then retry when requested |
| `api_error` | Report the numeric API code and HTTP status; follow the official documentation |
| `delivery_unknown` | Delivery is unconfirmed; preserve the same idempotency key, destination, and content for a retry |
| The execution environment rejects an operation | Report the specific action and returned reason, and follow the environment's normal authorization process |

The SDK manages reconnection. Confirm readiness through `transport_connected` or `transport_reconnected`. Sending does not retry automatically. A successful send requires both API code 0 and a returned message ID.

## Packaging and migration

Run `bash feishu.sh package` from the skill directory, or `pnpm package:feishu` from the repository root. If the output file already exists, choose another output filename. The archive contains code, tests, a blank configuration template, documentation, and a generated standalone pnpm lockfile. Packaging selects this skill's importer from the shared lockfile and preserves its dependency resolutions; the exported manifest also receives the root's pinned pnpm version. It excludes local configuration, inbox data, logs, caches, and node_modules.

Copy the archive to another computer, extract it, and run `setup` from the skill directory. Use the skill interaction or an existing file with `prepare`, then use the returned path for `check` and `start`.

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
