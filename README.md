# Dot Skills

Reusable skills for messaging, task management and scheduling, and moving local files to dot.

## Skill catalog

| Category | Skill | Use it to |
| --- | --- | --- |
| Messaging | [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | Receive private messages and group mentions; send or reply with explicit text, Markdown, or cards. |
| Messaging | [Remote Config Bridge](skills/messaging/remote-config-bridge/SKILL.md) | Keep configuration/credentials on the selected computer; bridge authorized operations and receipts through a reused local task. |
| Automation | [Manage Dot Tasks](skills/automation/manage-dot-tasks/SKILL.md) | Manage tasks, scheduling, authorized notifications/natural-language intake, and acceptance through one CLI and Markdown UI. |
| Files | [Transfer Local Files to dot](skills/files/transfer-local-files-to-dot/SKILL.md) | Copy selected local files through ChatGPT Library and verify exact bytes on dot. |

## Workflow: install and start task management

Ask dot to install and start Manage Dot Tasks. The agent selects the configuration’s actual environment. For a user-computer configuration orchestrated by dot, Remote Config Bridge keeps configuration and Feishu transport there and transports only authorized batches/results through a reused local task. Same-environment configurations use the direct connector. Both routes reuse verified recipients. You do not write integration code. Configuration, task execution, notifications and inbound message authorization remain explicit scopes. Ordinary Feishu conversation is the primary intake experience; dot interprets requests using the scoped conversation and task context. Scripts only validate, persist, and transport data.

```text
Install and start manage-dot-tasks from this repository.
Reuse my existing verified Feishu configuration on its original computer and
my private-chat mapping. If dot runs elsewhere, use remote-config-bridge and
keep credentials there; reuse one verified local task.
Start or reuse the matching receiver. Accept ordinary messages from my verified
sender/account/tenant/private chat as requests to query, create, or continue
tasks. Allow new task creation, and access only the existing tasks we agree on.
Ask me for missing scope or ambiguous references; do not infer extra authority.
Send an initial overview of those tasks, then meaningful progress, blockers,
failures, results, and verified completion as native cards. Also send progress
and results for new tasks created from my authorized messages in that chat.
Interpret messages yourself using scoped task and recent conversation context;
record your decision durably, and execute authorized work with your real tools.
Discover and bind conversation commitments, delegated work and local tasks
through your available tools. Report partial or unavailable discovery.
Continue the active start/process/record/ack loop until I ask you to stop,
reading yielded tool sessions and rearming after bounded idle timeouts.
```

If configuration, account, sender, destination or scope is missing, dot requests only that information and continues local task setup. Configuration routing is not a credential transfer. Remote Config Bridge has no arbitrary file read/export function and does not replace upload/download tools; distributing reviewed code may still require supported file transfer. Separate authorized ordinary-file transfers follow the transfer skill’s contract. Never describe a credential-bearing configuration as secret-free to bypass a restriction. No generic setup action silently starts a service or sends a message. The active loop depends on dot’s running tool calls, permissions and environment; it cannot wake an inactive dot.

Use an explicit agent-mode grant for this workflow. A missing existing-task scope is a question for the user, not an implicit all-tasks grant; `--tasks none --allow-new` supports new-task-only intake. The legacy `/tasks` command mode remains available and remains the CLI default for compatibility. Neither mode bypasses action-specific approval.

See the [task/server connector contract](skills/automation/manage-dot-tasks/references/connectors.md) for setup, recovery and extension details. Feishu cards use native columns; Markdown/text fallbacks require an explicit supported format choice.

## Use a skill

Install the complete skill directory from this repository or an exported archive through dot's supported installation workflow, then follow its `SKILL.md`. Each skill keeps its setup, commands, and troubleshooting in that directory.

For CLI use, Node.js 22.18+ is required; Feishu also needs pnpm 11.27.0 and dependency installation. Manage Dot Tasks, Remote Config Bridge and the transfer filesystem helper run with built-in Node modules only.

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
