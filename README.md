# Dot Skills

Reusable skills for task management, Feishu messaging, and verified file transfers.

## Start task management with Feishu

Copy this into dot to manage your existing and new dot/Codex tasks:

```text
Install and start Manage Dot Tasks with Feishu from https://github.com/fansenze/dot-skills.
Use my verified private chat to manage my existing and new dot/Codex tasks
through natural language. Send an initial overview and meaningful updates there.
```

Dot reuses your verified configuration and chat mapping, or asks for the missing details. It sets up the required skills, routes transport to the computer that owns the configuration, and reuses a matching receiver. Credentials stay there. No integration code is needed. The active loop runs while dot is active; it cannot wake an inactive dot.

For new tasks only, use this alternative:

```text
Install and start Manage Dot Tasks with Feishu from https://github.com/fansenze/dot-skills.
In my verified private chat, accept ordinary messages to create and continue new tasks,
and send their progress and results there. Include only tasks created through this chat.
```

To resume an already configured workflow:

```text
Resume Manage Dot Tasks with Feishu using the existing verified setup and scope.
```

You can specify where task work should run, such as “Run my tasks on dot” or “Use my connected Mac.” Transport location does not choose the task executor. Sending messages, creating tasks, and carrying out their actions remain separate permissions. For task management without messaging, ask “Install and initialize Manage Dot Tasks locally, without Feishu.”

## Install an individual skill

Use dot's supported skill installation workflow with the complete directory or an exported archive. Then follow its `SKILL.md`. For the combined workflow, Manage Dot Tasks is the entry point; it owns the [startup procedure](skills/automation/manage-dot-tasks/references/startup.md), so there is no extra workflow skill to install.

CLI requirements: Node.js 22.18+. Feishu additionally needs pnpm 11.27.0 and its dependencies; tasks, bridge and transfer use Node built-ins only.

## Skill catalog

| Category | Skill | Use it to |
| --- | --- | --- |
| Messaging | [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | Receive private messages and group mentions; send or reply with explicit text, Markdown, or cards. |
| Messaging | [Remote Config Bridge](skills/messaging/remote-config-bridge/SKILL.md) | Keep configuration/credentials on the selected computer; bridge authorized operations and receipts through a reused local task. |
| Automation | [Manage Dot Tasks](skills/automation/manage-dot-tasks/SKILL.md) | Manage tasks, scheduling, authorized notifications/natural-language intake, and acceptance through one CLI and Markdown UI. |
| Files | [Transfer Local Files to dot](skills/files/transfer-local-files-to-dot/SKILL.md) | Copy selected local files through ChatGPT Library and verify exact bytes on dot. |

## For maintainers

Repository guidance is in [AGENTS.md](AGENTS.md). Runtime protocols and recovery instructions stay inside each skill; user prompts contain intent and scope only.

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
| `pnpm package:tasks-with-feishu` | `dist/manage-dot-tasks-with-feishu.zip` (task, Feishu and bridge skills plus manifest) |
| `pnpm package:bridge` | `dist/remote-config-bridge.tgz` |
| `pnpm package:transfer` | `dist/transfer-local-files-to-dot.zip` |

Extract into a separate directory. From the extracted skill directory, check:

- **Feishu:** `bash feishu.sh setup`, `bash feishu.sh validate`, then `bash feishu.sh test`.
- **Tasks:** `node --test tests/*.test.mjs`.
- **Bridge:** `node scripts/validate.mjs`, then `node --test tests/*.test.mjs` (fourteen upstream tests plus orchestration/package scenarios).
- **Transfer:** `node scripts/validate.mjs`, then `node --test tests/*.test.mjs`.

These checks use synthetic data; live delivery and monitoring require verification in dot. For repository maintenance and contribution rules, see [AGENTS.md](AGENTS.md).

The combined archive includes the complete task, Feishu and Remote Config Bridge skills. Feishu has a generated standalone lockfile; task and bridge need no dependencies or lockfile. A standalone Feishu archive includes the remote routing recipe and resolves the separately installed bridge through the catalog/repository. Verify every entry against `MANIFEST.json`; extract separately, install Feishu dependencies with its `setup`, and run all three skills’ checks. Set `FEISHU_SKILL_PATH` to the extracted companion when running task tests to include the cross-skill cursor/capability fixture. Packaging and tests never start a real service.

## Repository layout and categories

```text
skills/
  automation/manage-dot-tasks/
  messaging/feishu-message-server/
  messaging/remote-config-bridge/
  files/transfer-local-files-to-dot/
```

Messaging skills handle transport, automation owns task state/scheduling, and the file skill handles explicitly authorized ordinary-byte transfers. Remote Config Bridge does not add a general file transfer channel. Its [orchestration guide](skills/messaging/remote-config-bridge/references/orchestration.md) includes one-prompt setup, existing-config reuse, typed task-message boundaries, exact batch/receipt replay and late-result handling.
