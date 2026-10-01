# Dot Skills

A growing collection of reusable skills for Dot, organized as a pnpm monorepo. Each skill owns its instructions, supporting files, and dependency declarations. The repository uses one shared lockfile at the root; export an individual skill when it needs to run outside the checkout.

## Skill catalog

### Messaging

Skills for receiving, storing, sending, and replying to messages across communication platforms.

| Skill | Directory | What it does | Requirements |
| --- | --- | --- | --- |
| [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | [`skills/messaging/feishu-message-server/`](skills/messaging/feishu-message-server/) | Runs a Feishu/Lark long-connection listener; stores private messages and group messages mentioning the bot; sends or replies with text when requested. Incoming messages do not automatically trigger tasks or replies. | Node.js 22.18+, pnpm 11.27.0 |

Feishu Message Server defaults to domestic Feishu. Select `lark` explicitly for the international platform. It accepts YAML or JSON configuration and starts the server as soon as setup prepares the configuration. When the user selects a configuration file on their computer for a server on Dot, it installs and invokes Transfer Local Files to dot first, then uses the verified Dot-local file. It also provides missing-key diagnostics, a local inbox, and a portable archive command.

See its [operations guide](skills/messaging/feishu-message-server/references/operations.md) for commands and its [validation record](skills/messaging/feishu-message-server/references/validation.md) for tested behavior and coverage limits.

### Automation

Skills for task coordination and repeatable operational workflows.

| Skill | Directory | What it does | Requirements |
| --- | --- | --- | --- |
| [Manage Dot Tasks](skills/automation/manage-dot-tasks/SKILL.md) | [`skills/automation/manage-dot-tasks/`](skills/automation/manage-dot-tasks/) | Maintains a file-backed task ledger with goals, steps, blockers, evidence, acceptance checks, and Markdown list/detail views. | Node.js 22.18+ on Linux/macOS; built-in modules only |

Manage Dot Tasks keeps task data outside the reusable skill. The CLI records observed progress and verified outcomes; it does not schedule work or monitor execution in the background. During assistant-led activation, follow its [first-use workflow](skills/automation/manage-dot-tasks/references/first-use.md) for the authorized platform-memory convention. See the [CLI guide](skills/automation/manage-dot-tasks/references/cli.md) for commands and the [data model](skills/automation/manage-dot-tasks/references/model.md) for state and recovery rules.

### Files

Skills for moving explicitly selected files between the user's connected computer and Dot.

| Skill | Directory | What it does | Requirements |
| --- | --- | --- | --- |
| [Transfer Local Files to dot](skills/files/transfer-local-files-to-dot/SKILL.md) | [`skills/files/transfer-local-files-to-dot/`](skills/files/transfer-local-files-to-dot/) | Uses official ChatGPT Library transport with a local producer and Dot consumer; preserves opaque payload bytes and verifies archive and file hashes. | Dot orchestration, a connected computer, ChatGPT Library; Node.js 22.18+ for the filesystem CLI |

The transfer skill does not view, parse, scan, log, or modify file bodies. Scope and sensitive-data decisions use metadata, the user's description, and existing context. Its Node CLI only packages and verifies bytes; Dot owns delegation, Library transport, and final consumer acceptance. See the [CLI guide](skills/files/transfer-local-files-to-dot/references/cli.md), [handoff contract](skills/files/transfer-local-files-to-dot/references/handoff.md), and [validation record](skills/files/transfer-local-files-to-dot/references/validation.md).

### Category map

Use the following categories as the collection grows. Only categories containing a skill need a directory.

| Category | Directory | Intended contents | Current contents |
| --- | --- | --- | --- |
| Messaging | `skills/messaging/` | Chat integrations, message transport, notifications, and inbox utilities | Feishu Message Server |
| Automation | `skills/automation/` | Task coordination and repeatable operational workflows | Manage Dot Tasks |
| Files | `skills/files/` | Authorized file movement, packaging, and integrity verification | Transfer Local Files to dot |
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
    ├── automation/
    │   └── manage-dot-tasks/
    │       ├── SKILL.md
    │       ├── agents/openai.yaml
    │       ├── assets/
    │       ├── package.json
    │       ├── scripts/
    │       ├── tests/
    │       ├── references/
    │       └── ui/
    ├── files/
    │   └── transfer-local-files-to-dot/
    │       ├── SKILL.md
    │       ├── agents/openai.yaml
    │       ├── assets/
    │       ├── package.json
    │       ├── scripts/
    │       ├── tests/
    │       └── references/
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
# Dot immediately uses the config path returned by prepare:
pnpm feishu start --config /path/to/temporary/config.yml
```

The required configuration keys are `app_id` and `app_secret`. Optional keys are `brand` and `bot_open_id`. Stop the listener with Ctrl-C and remove the temporary configuration when it is no longer needed.

For Manage Dot Tasks, the root shortcut forwards options to the CLI. Select a store outside the checkout, and place global options before the command:

```bash
pnpm tasks --help
pnpm tasks --store /path/to/task-store init
pnpm tasks --store /path/to/task-store list --all
pnpm tasks --store /path/to/task-store render list
pnpm tasks --store /path/to/task-store doctor
```

An exported Manage Dot Tasks skill runs directly with `node scripts/taskctl.mjs`; it needs no dependency installation. Its default store paths and `DOT_TASKS_HOME` override are described in `SKILL.md`. CLI initialization prepares local files only; any platform-memory step belongs to the invoking assistant's first-use workflow.

For Transfer Local Files to dot, read its skill instructions in Dot before selecting the connected computer and source. The repository shortcut exposes the filesystem helper:

```bash
pnpm transfer --help
pnpm transfer pack --source /absolute/authorized/source --output /absolute/existing/parent/new-package
```

The output directory must be new and outside the selected source. These commands create local bytes and metadata only. The invoking Dot task uses official Library transport and reports success only after its consumer verifies the transferred bytes. An exported skill uses `node scripts/transfer.mjs` directly, with no dependency installation.

## Validate and package

Run the shared commands from the repository root. `pnpm check` runs each package's available validation and test scripts. Feishu tests use mocked SDK responses and a local loopback HTTP fixture; task-ledger tests use isolated temporary stores and synthetic compatibility fixtures; transfer tests use synthetic opaque payloads and malformed archives:

```bash
pnpm check
pnpm package:feishu
pnpm package:tasks
pnpm package:transfer
```

Feishu Message Server exports to `skills/messaging/feishu-message-server/dist/feishu-message-server-node.tgz`. It contains the skill's code, tests, blank configuration template, and documentation. Packaging derives a standalone pnpm lockfile from the shared lock and adds the pinned package-manager version to the exported manifest. This generated lockfile exists only in the archive; no per-skill lockfile is maintained in the repository. Installed dependencies and runtime files stay outside the archive.

After extracting the archive, run `bash feishu.sh setup` from its directory, then follow `SKILL.md`. The wrapper also works inside the monorepo, where `setup` automatically locates the repository root and uses its frozen shared lockfile.

Manage Dot Tasks exports to `dist/manage-dot-tasks.zip` at the repository root. Its deterministic ZIP includes instructions, code, templates, metadata, and synthetic tests. Extract it anywhere, then follow `manage-dot-tasks/SKILL.md`. The archive needs no lockfile because the skill has no third-party dependencies. Validate the extracted copy with `node --test manage-dot-tasks/tests/taskctl.test.mjs`.

Transfer Local Files to dot exports to `dist/transfer-local-files-to-dot.zip`. Its deterministic ZIP contains an explicit allowlist of reusable skill files, including synthetic tests and the exporter. It excludes user payloads, receipts, temporary Library helpers, and runtime files. Extract it into a separate directory, then run `node transfer-local-files-to-dot/scripts/validate.mjs` and `node --test transfer-local-files-to-dot/tests/*.test.mjs`. It needs no standalone lockfile or dependency installation. Packaging tests do not establish a successful transfer between computers.

## Add another skill

1. Choose the best-fitting category and create `skills/<category>/<skill-name>/`. Use lowercase names separated by hyphens and keep skill names unique across the repository.
2. Add `SKILL.md` with a matching `name` and a concise description of when to use the skill. Keep instructions, examples, and CLI help in English.
3. Keep supporting scripts, templates, tests, and references inside the skill directory. For a Node skill, declare dependencies and `validate`/`test` scripts in its own `package.json`, then run `pnpm install` at the repository root to update the shared lockfile. Document its requirements, setup, configuration, commands, and expected results.
4. Use relative paths and blank or clearly illustrative configuration examples. Keep local configuration, logs, inbox data, installed dependencies, and generated archives out of tracked files.
5. Add a catalog section or row under the matching category in this README. Describe what the skill does and link to its entry point. Update the category map and layout when adding a new directory.
6. Run `pnpm check` and verify any exported archive in a separate directory. Keep standalone-export support with the skill that provides it and record remaining coverage limits there.

Keep changes to unrelated skills separate so each directory can evolve and be reviewed independently.
