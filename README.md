# Dot Skills

Reusable skills for messaging, task tracking, and moving local files to dot.

## Skill catalog

| Category | Skill | Use it to |
| --- | --- | --- |
| Messaging | [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | Receive private messages and group mentions; send or reply with text. |
| Automation | [Manage Dot Tasks](skills/automation/manage-dot-tasks/SKILL.md) | Track goals, progress, blockers, results, and acceptance evidence. |
| Files | [Transfer Local Files to dot](skills/files/transfer-local-files-to-dot/SKILL.md) | Copy selected local files through ChatGPT Library and verify exact bytes on dot. |

## Workflow: track Dot and local tasks in Feishu

Send Dot and local task updates to Feishu. Markdown is delivered as plain text.

### Before you start

- **Allow local access:** in the ChatGPT desktop app, open your dot's profile → **Computers** → **Your computer** → **Allow access** and confirm. Keep the computer online with the app running. See the [official setup guide](https://learn.chatgpt.com/docs/dots/computers-and-apps#connect-your-computer).
- **Prepare your Feishu config:** the file must contain `app_id` and `app_secret`. You only need its path for the prompt.

### Copy this prompt

Copy the **entire text block below** into dot. Replace `<FEISHU_CONFIG_PATH>` with your local file path, or `reuse existing Dot config`. Change the `Notify` line only if needed.

```text
Feishu config: <FEISHU_CONFIG_PATH>
Notify: my Feishu private chat

Use https://github.com/fansenze/dot-skills. Follow each skill's instructions
and complete these steps in order. If blocked, report why and stop
dependent steps.

1. Use transfer-local-files-to-dot to transfer the selected config to dot
   through ChatGPT Library without reading or displaying its contents.
   Reuse the selected config or a verified copy of it if already on dot.

2. Once the config is ready on dot, use feishu-message-server to configure
   and start the server with it, then report the verified connection state
   and resolve Notify.

3. Use manage-dot-tasks to track all existing and new Dot and local tasks,
   including locally started tasks. Send an initial overview, then
   progress, blockers, failures and verified completion to Notify through
   feishu-message-server. Render Markdown and record send results.
   Continue until I ask you to stop. Skip duplicate or unchanged updates
   and the monitor's own routine checks. Report monitoring gaps.
```

## Use a skill

Install the complete skill directory from this repository or an exported archive through dot's supported installation workflow, then follow its `SKILL.md`. Each skill keeps its setup, commands, and troubleshooting in that directory.

For CLI use, Node.js 22.18+ is required; Feishu also needs pnpm 11.27.0 and dependency installation. Manage Dot Tasks and the transfer filesystem helper run with built-in Node modules only.

## Validate and package

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm check
```

| Export command | Archive |
| --- | --- |
| `pnpm package:feishu` | `skills/messaging/feishu-message-server/dist/feishu-message-server-node.tgz` |
| `pnpm package:tasks` | `dist/manage-dot-tasks.zip` |
| `pnpm package:transfer` | `dist/transfer-local-files-to-dot.zip` |

Extract into a separate directory. From the extracted skill directory, check:

- **Feishu:** `bash feishu.sh setup`, `bash feishu.sh validate`, then `bash feishu.sh test`.
- **Tasks:** `node --test tests/taskctl.test.mjs`.
- **Transfer:** `node scripts/validate.mjs`, then `node --test tests/*.test.mjs`.

These checks use synthetic data; live delivery and monitoring require verification in dot. For repository maintenance and contribution rules, see [AGENTS.md](AGENTS.md).
