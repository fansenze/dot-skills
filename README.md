# Dot Skills

A growing collection of reusable skills for Dot, organized as a pnpm monorepo. Each skill owns its instructions, supporting files, and dependency declarations. The repository uses one shared lockfile at the root; export an individual skill when it needs to run outside the checkout.

## Skill catalog

### Messaging

Skills for receiving, storing, sending, and replying to messages across communication platforms.

| Skill | Directory | What it does | Requirements |
| --- | --- | --- | --- |
| [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | [`skills/messaging/feishu-message-server/`](skills/messaging/feishu-message-server/) | Runs a Feishu/Lark long-connection listener; stores private messages and group messages mentioning the bot; sends or replies with text when requested. Incoming messages do not automatically trigger tasks or replies. | Node.js 22.18+, pnpm 11.27.0 |

Feishu Message Server defaults to domestic Feishu. Select `lark` explicitly for the international platform. It accepts YAML or JSON configuration and provides temporary configuration preparation, missing-key checks, a local inbox, and a portable archive command.

See its [operations guide](skills/messaging/feishu-message-server/references/operations.md) for commands and its [validation record](skills/messaging/feishu-message-server/references/validation.md) for tested behavior and coverage limits.

### Category map

Use the following categories as the collection grows. Only categories containing a skill need a directory.

| Category | Directory | Intended contents | Current contents |
| --- | --- | --- | --- |
| Messaging | `skills/messaging/` | Chat integrations, message transport, notifications, and inbox utilities | Feishu Message Server |
| Automation | `skills/automation/` | Task coordination and repeatable operational workflows | No skills yet |
| Documents | `skills/documents/` | Document, spreadsheet, presentation, and report workflows | No skills yet |
| Development | `skills/development/` | Repository, code review, testing, and developer tooling workflows | No skills yet |
| Research | `skills/research/` | Information gathering, comparison, analysis, and synthesis | No skills yet |

## Repository layout

```text
dot-skills/
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── skills/
    └── messaging/
        └── feishu-message-server/
            ├── SKILL.md
            ├── agents/openai.yaml
            ├── config.example.yml
            ├── feishu.sh
            ├── package.json
            ├── scripts/
            ├── tests/
            └── references/
```

`SKILL.md` is the entry point for each skill. Node packages under `skills/*/*` are workspace members. Each package declares its own dependencies; the root `package.json` provides shared commands and pins pnpm. Only the root `pnpm-lock.yaml` is tracked. Runtime configuration remains local to each skill.

## Use a skill

1. Find the skill in the catalog and read its `SKILL.md`.
2. Use a repository checkout or extract the skill's exported archive in the environment where Dot will run it.
3. Follow that skill's setup and configuration workflow. Relative paths resolve within the skill directory.

Use Node.js 22.18+ and pnpm 11.27.0. From the repository root, install the shared dependency tree once. For Feishu Message Server, Dot prepares configuration and runs the commands during the skill interaction; the same workflow is available through the root CLI shortcut:

```bash
pnpm install --frozen-lockfile
pnpm feishu prepare --config /path/to/config.yml
# Use the config path returned by prepare:
pnpm feishu check --config /path/to/temporary/config.yml
pnpm feishu start --config /path/to/temporary/config.yml
```

The required configuration keys are `app_id` and `app_secret`. Optional keys are `brand` and `bot_open_id`. Stop the listener with Ctrl-C and remove the temporary configuration when it is no longer needed.

## Validate and package

Run the shared commands from the repository root. `pnpm check` runs each package's available validation and test scripts. The Feishu skill includes offline tests with mocked SDK responses and a local loopback HTTP fixture:

```bash
pnpm check
pnpm package:feishu
```

The archive is written to `skills/messaging/feishu-message-server/dist/feishu-message-server-node.tgz`. It contains the skill's code, tests, blank configuration template, and documentation. Packaging derives a standalone pnpm lockfile from the shared lock and adds the pinned package-manager version to the exported manifest. This generated lockfile exists only in the archive; no per-skill lockfile is maintained in the repository. Installed dependencies and runtime files stay outside the archive.

After extracting the archive, run `bash feishu.sh setup` from its directory, then follow `SKILL.md`. The wrapper also works inside the monorepo, where `setup` automatically locates the repository root and uses its frozen shared lockfile.

## Add another skill

1. Choose the best-fitting category and create `skills/<category>/<skill-name>/`. Use lowercase names separated by hyphens and keep skill names unique across the repository.
2. Add `SKILL.md` with a matching `name` and a concise description of when to use the skill. Keep instructions, examples, and CLI help in English.
3. Keep supporting scripts, templates, tests, and references inside the skill directory. For a Node skill, declare dependencies and `validate`/`test` scripts in its own `package.json`, then run `pnpm install` at the repository root to update the shared lockfile. Document its requirements, setup, configuration, commands, and expected results.
4. Use relative paths and blank or clearly illustrative configuration examples. Keep local configuration, logs, inbox data, installed dependencies, and generated archives out of tracked files.
5. Add a catalog section or row under the matching category in this README. Describe what the skill does and link to its entry point. Update the category map and layout when adding a new directory.
6. Run `pnpm check` and verify any exported archive in a separate directory. Keep standalone-export support with the skill that provides it and record remaining coverage limits there.

Keep changes to unrelated skills separate so each directory can evolve and be reviewed independently.
