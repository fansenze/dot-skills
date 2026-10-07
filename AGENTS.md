# Repository guidance

Dot Skills is a pnpm workspace of reusable, independently exportable skills. Keep repository maintenance instructions in this root file; keep each skill's operational workflow in its `SKILL.md` and `references/`.

Reading or editing a skill is repository maintenance, not activation of that skill. Installation, listener startup, platform-memory writes, messages, and real file transfers belong to the user's requested operational task.

## Find the relevant code

| Skill | Directory | Workspace package |
| --- | --- | --- |
| Feishu Message Server | `skills/messaging/feishu-message-server/` | `feishu-message-server-skill` |
| Remote Config Bridge | `skills/messaging/remote-config-bridge/` | `remote-config-bridge-skill` |
| Manage Dot Tasks | `skills/automation/manage-dot-tasks/` | `manage-dot-tasks-skill` |
| Transfer Local Files to dot | `skills/files/transfer-local-files-to-dot/` | `transfer-local-files-to-dot-skill` |

Read the affected skill's `SKILL.md` and the references relevant to the change. Use [README.md](README.md) for the catalog, setup, and export instructions. `agents/openai.yaml` holds skill metadata, not repository maintenance instructions.

## Toolchain and dependencies

- Use Node.js 22.18.0+ and pnpm 11.27.0, as declared in the root `package.json`. Runtime scripts are JavaScript ESM (`.mjs`).
- Install from the repository root with `pnpm install --frozen-lockfile`.
- Declare dependencies in the owning skill's `package.json`. For intentional dependency changes, update the shared lockfile with `pnpm install` from the root.
- Track only the root `pnpm-lock.yaml`. Preserve the workspace's `ignoreScripts: true` setting.
- Manage Dot Tasks, Remote Config Bridge, and Transfer Local Files to dot use built-in Node modules and run without dependency installation. Preserve this standalone behavior when changing their implementations.

## Editing and adding skills

- Use `skills/<category>/<skill-name>/`, with unique lowercase hyphenated skill names and a matching `SKILL.md` frontmatter `name`.
- Keep scripts, tests, templates, assets, and references inside their owning skill. Use relative links and paths that remain valid after export.
- Write skill instructions, examples, metadata, and CLI help in English. Preserve user-authored task text and the task ledger's existing optional Chinese views.
- Keep behavior, CLI help, `SKILL.md`, relevant references, and `agents/openai.yaml` consistent when a change affects them.
- Update the README catalog, category map, and layout when adding or moving a skill. Give new Node packages appropriate `validate` and `test` scripts.
- Keep changes to unrelated skills separate. Follow the affected file's existing style.

## Preserve the skill contracts

- Feishu receives and stores messages without automatically replying or executing tasks. Preserve its distinction between process startup, connection readiness, message receipt, and send results; see its [skill instructions](skills/messaging/feishu-message-server/SKILL.md).
- Manage Dot Tasks unifies task records, durable scheduling, and Markdown views. Preserve state, locking, recovery, compatibility, and acceptance rules. Its Node scheduler does not execute platform tasks or establish platform-memory persistence; dot uses actual tools to consume authorized requests. See its [data model](skills/automation/manage-dot-tasks/references/model.md) and [scheduling contract](skills/automation/manage-dot-tasks/references/scheduling.md).
- Remote Config Bridge preserves the accepted durable operation/replay and generation-safe locking contract. Config/credentials and Feishu transport stay on the selected computer; only authorized operation batches/receipts cross through actual agent task tools. It is not arbitrary file transfer. See its [orchestration guide](skills/messaging/remote-config-bridge/references/orchestration.md).
- File transfer preserves opaque payload bytes. Keep filesystem packaging and verification separate from Dot's official Library transport and consumer acceptance; see its [handoff contract](skills/files/transfer-local-files-to-dot/references/handoff.md).

## Validation

These commands are for repository maintenance and release/export validation. Installing, starting, or resuming an existing skill follows its operational checks; it does not require repository regression tests.

Run maintenance commands from the repository root:

```sh
pnpm check
pnpm --filter <workspace-package> run validate
pnpm --filter <workspace-package> run test
```

- `pnpm check` runs available validators and Node test suites. Use it for runtime, dependency, metadata, workspace changes, and new skills; focused package commands help during iteration.
- For documentation-only changes, check affected links, paths, examples, and consistency with the implementation. Review relevant synthetic scenarios when operational instructions change.
- Use the existing mocked SDK responses, local loopback fixture, temporary stores, and synthetic payloads. Normal repository checks need no real credentials or external service operations.
- Report actual checks and coverage limits. Local tests do not prove live Feishu delivery, platform-memory persistence, or a completed cross-machine transfer.

## Portable exports

- Root export commands are `pnpm package:feishu`, `pnpm package:tasks`, `pnpm package:tasks-with-feishu`, `pnpm package:bridge`, and `pnpm package:transfer`; output locations and extraction checks are documented in the [README](README.md#validate-and-package).
- When changing dependencies, packaged files, layout, or runtime entry points, verify the affected archive in a separate directory.
- Review each skill's `scripts/package.mjs` when adding files. Feishu, bridge, and transfer use explicit file lists; task packaging rejects unexpected top-level entries. Keep this `AGENTS.md` at the repository root.
- Feishu derives a standalone lockfile from the shared workspace lock during export. Task, bridge, and transfer archives require no lockfile or third-party dependencies.
- Keep runtime data, installed dependencies, and generated archives outside the reusable export contents.

## Local data

- Keep real configuration, credentials, inbox messages, task stores, transfer payloads, and receipts out of tracked files and examples. Use blank or clearly synthetic examples and preserve `.gitignore` exclusions.
- Keep real task stores outside the checkout. Use temporary directories and fabricated data for tests.
