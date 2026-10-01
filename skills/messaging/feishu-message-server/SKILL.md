---
name: feishu-message-server
description: Configure and start a Node.js Feishu message server, including importing a user-selected local configuration file to dot. Receive private messages to the bot and group messages that mention it, and send or reply with text when requested. Use for setup, startup, inbox inspection, messaging, troubleshooting, and migration.
---

# Feishu Message Server

Complete the user's requested configuration, startup, inbox inspection, or messaging operation with the bundled scripts. The server stores incoming messages without automatically executing tasks or replying.

Run the examples from this skill directory. Requirements: Node.js 22.18+ and pnpm 11.27.0. Use a repository checkout or an extracted portable archive so its pnpm lockfile is available. Supported environments: macOS, Linux, and Windows through WSL.

## Configuration and startup

Setup and configuration requests include starting the server as soon as configuration succeeds, unless the user explicitly asks to prepare configuration without starting. Complete this in the same interaction without another startup confirmation or manual terminal steps. Inbox inspection, sending, and other existing-instance operations do not themselves require a new listener.

1. Resolve the selected configuration in the environment where the server will run. Reuse an available runtime configuration from this conversation only if it matches the user's current selection. When the user supplies a path on their connected computer for a server on dot, first install and invoke `files/transfer-local-files-to-dot` as described below. Use its verified dot-local file path as `SOURCE`. A producer path or upload ID is not a readable file on dot. Otherwise, use an already available source or the existing `.local/config.yml`. Run `bash feishu.sh setup` only if dependencies are missing; it uses the repository's shared lockfile or the export's standalone lockfile.
2. Run `prepare --config SOURCE` for a file. Without a source file, pass the configuration object supplied by the user to `prepare --stdin-json` through standard input; pass `{}` if no values are available yet. If the result contains `missing`, ask only for those key names, for example: "Please provide app_id and app_secret." Do not append descriptions. Complete a partial file with `prepare --config SOURCE --stdin-json`, passing the additional values through standard input. Preparation leaves the source unchanged.
3. As soon as `prepare` returns `ok: true`, immediately run `start --config RETURNED_CONFIG`. If configuration was created with `init`, immediately start with that initialized file instead. Reuse an existing running instance with matching configuration. Do not insert another `check`, validation suite, test message, packaging step, or confirmation between successful preparation and startup.

### Local configuration files for dot

Install the dependency from `skills/files/transfer-local-files-to-dot` in this repository using dot's supported skill-installation workflow, then read and invoke its `SKILL.md`. In a checkout, its source is `../../files/transfer-local-files-to-dot` relative to this skill. For a standalone Feishu export, obtain that directory from the [dot-skills repository](https://github.com/fansenze/dot-skills); it is not bundled in the Feishu archive. Reuse a current installed copy. Install the whole skill, including its helper and references, rather than copying only `SKILL.md`; resolve the helper separately on the producer computer.

Invoke the transfer skill for the exact user-selected YAML/JSON file and the purpose of configuring the Feishu server on dot. Follow its Feishu configuration handoff and current Library transport. Carry the existing user authorization into the handoff; do not make the user request installation or transfer again. Transfer the file without displaying its contents or putting `app_secret` in a prompt, command argument, or log. Continue only after `materialized_and_verified`, using the returned `consumer_local_root` as the source file for `prepare`. Reuse a verified copy already transferred for the same selection. Report any actual installation or transfer blocker before attempting preparation; do not substitute the producer path or a generic upload method.

This transfer dependency applies when the configuration must move from the user's computer to dot. A file already available on dot, values supplied during the interaction, or an explicitly local-only server can proceed directly to preparation.

Required keys: `app_id`, `app_secret`. Optional keys: `brand`, `bot_open_id`. The default `brand` is `feishu`; use the international platform only when `lark` is explicitly selected.

`prepare` already reports missing required keys. `check` remains available for a requested diagnostic; it is not part of the normal prepare-and-start flow. Missing-field prompts list key names only.

```bash
bash feishu.sh prepare --config /path/to/config.yml
# Immediately use the config path returned by prepare:
bash feishu.sh start --config /path/to/temporary/config.yml
```

Use the same runtime configuration path for subsequent `start`, `send`, and `reply` commands. Keep the temporary file while the instance and follow-up operations need it. After the instance stops and the file is no longer needed, remove only the temporary directory created by this invocation of `prepare`. The persistent `init` entry point remains available, but is not required for the skill interaction.

Launch the foreground server in the execution environment's supported long-running process session and retain its session handle. Confirm connection readiness through `transport_connected` or `transport_reconnected`, then report that the server is running. A prepared configuration or spawned process alone is not connection readiness. If startup fails, report the actual error and next step. The one-line startup wrapper is `bash /path/to/feishu-message-server/feishu.sh start --config /path/to/config.yml`.

## Receiving and sending

Receive private messages to the bot and group messages that mention this bot. Ignore other group messages. Store message content and type, and deduplicate by message and event IDs. Store non-text content without downloading attachments. See [Operations](references/operations.md) for details.

```bash
bash feishu.sh inbox --limit 10
bash feishu.sh inbox --limit 10 --show-text
bash feishu.sh send --config /path/to/temporary/config.yml --receive-id oc_example --text 'Test message'
bash feishu.sh reply --config /path/to/temporary/config.yml --message-id om_example --text 'Test reply'
```

Use the destination and content requested by the user, including chats or messages already confirmed in this conversation. When the request is complete and authorized, execute it without asking for the same confirmation again. Both private and group messages can use the corresponding `chat_id`; replies use a `message_id`. These are per-operation arguments and do not belong in the configuration file.

`inbox` shows message metadata by default; `--show-text` also includes content. Outgoing text can also come from `--stdin` or `--text-file`. Report the returned message ID on success and the error code on failure. For `delivery_unknown`, report that delivery is unconfirmed. If the user requests a retry, preserve the destination, content, and `idempotency_key`.

## Troubleshooting and migration

Missing configuration, unavailable Feishu permissions, or execution-environment restrictions can prevent an operation. Report the actual result, cause, and next step. Continue steps already covered by the user's authorization. The server runs in the foreground; Ctrl-C stops it.

```bash
bash feishu.sh validate
bash feishu.sh test
bash feishu.sh package
```

To migrate, create and copy `dist/feishu-message-server-node.tgz`, extract it, run `setup`, and follow the configuration workflow above before starting. The archive includes code, templates, documentation, and a standalone pnpm lockfile derived from the shared repository lock. Local configuration, logs, inbox data, and installed dependencies are excluded.

[Operations](references/operations.md) covers network behavior, file locations, platform permissions, and troubleshooting. [Validation](references/validation.md) records completed checks and remaining coverage limits.
