---
name: feishu-message-server
description: Configure and run a local Node.js Feishu message server. Receive private messages to the bot and group messages that mention it, and send or reply with text when requested. Use for setup, startup, inbox inspection, messaging, troubleshooting, and migration.
---

# Feishu Message Server

Complete the user's requested configuration, startup, inbox inspection, or messaging operation with the bundled scripts. The server stores incoming messages without automatically executing tasks or replying.

Run the examples from this skill directory. Requirements: Node.js 22.18+ and pnpm 11.27.0. Use a repository checkout or an extracted portable archive so its pnpm lockfile is available. Supported environments: macOS, Linux, and Windows through WSL.

## Configuration and startup

Check for missing configuration whenever this skill is invoked. Accept a YAML/JSON file or values provided during the skill interaction. Run the commands for the user; manual terminal input is not required.

1. Reuse an available runtime configuration already prepared in this conversation. Otherwise, use the user-selected file or the existing `.local/config.yml`. Run `bash feishu.sh setup` if dependencies are missing. In a repository checkout, it installs from the root shared lockfile; an exported archive uses its generated standalone lockfile.
2. For an existing source file, verify that it is readable in the environment where the scripts will run, then run `check --config SOURCE`. If the file is in another environment, copy it through that environment's supported file-transfer workflow first. A remote path alone does not establish local availability.
3. If no required keys are missing, run `prepare --config SOURCE`. The script copies the file into the current execution environment's temporary directory. Keep the returned `config` path.
4. Without a source file, pass the configuration object supplied by the user to `prepare --stdin-json` through standard input. Pass `{}` if no values are available yet. If the result contains `missing`, ask only for those key names, for example: "Please provide app_id and app_secret." Do not append descriptions of the keys. Once the values are available, call `prepare` again to write the temporary file.
5. To complete a partial source file, use `prepare --config SOURCE --stdin-json`. Pass the additional values through standard input; the script merges them into a temporary file and leaves the source unchanged.
6. Run `check --config TEMPORARY_FILE`. If the user requested startup, continue with `start --config TEMPORARY_FILE`. If the request only covers configuration, finish after the check succeeds. Reuse an existing running instance with matching configuration.

Required keys: `app_id`, `app_secret`. Optional keys: `brand`, `bot_open_id`. The default `brand` is `feishu`; use the international platform only when `lark` is explicitly selected.

`check` checks only whether required configuration is missing. It returns `{"ok":true}` or, for example, `{"ok":false,"missing":["app_secret"]}`. Missing-field prompts list key names only.

```bash
bash feishu.sh prepare --config /path/to/config.yml
# Use the config path returned by prepare:
bash feishu.sh check --config /path/to/temporary/config.yml
bash feishu.sh start --config /path/to/temporary/config.yml
```

Use the same runtime configuration path for subsequent `start`, `send`, and `reply` commands. Keep the temporary file while the instance and follow-up operations need it. After the instance stops and the file is no longer needed, remove only the temporary directory created by this invocation of `prepare`. The persistent `init` entry point remains available, but is not required for the skill interaction.

Confirm connection readiness through `transport_connected` or `transport_reconnected`. The one-line startup wrapper is `bash /path/to/feishu-message-server/feishu.sh start --config /path/to/config.yml`.

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
