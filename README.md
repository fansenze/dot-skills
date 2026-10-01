# Dot Skills

A growing collection of reusable skills for Dot. Each skill lives in its own directory and includes its instructions, supporting files, and runtime requirements. Copy or use individual skill directories independently of the rest of this repository.

## Skill catalog

### Messaging

Skills for receiving, storing, sending, and replying to messages across communication platforms.

| Skill | Directory | What it does | Requirements |
| --- | --- | --- | --- |
| [Feishu Message Server](skills/messaging/feishu-message-server/SKILL.md) | [`skills/messaging/feishu-message-server/`](skills/messaging/feishu-message-server/) | Runs a Feishu/Lark long-connection listener; stores private messages and group messages mentioning the bot; sends or replies with text when requested. Incoming messages do not automatically trigger tasks or replies. | Node.js 22.18+, npm |

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
└── skills/
    └── messaging/
        └── feishu-message-server/
            ├── SKILL.md
            ├── agents/openai.yaml
            ├── config.example.yml
            ├── feishu.sh
            ├── package.json
            ├── package-lock.json
            ├── scripts/
            ├── tests/
            └── references/
```

`SKILL.md` is the entry point for each skill. Supporting scripts and reference documents stay beside it so the whole directory remains portable. Dependencies and runtime configuration are managed per skill; there is no repository-wide runtime requirement.

## Use a skill

1. Find the skill in the catalog and read its `SKILL.md`.
2. Make the complete skill directory available in the environment where Dot will run it.
3. Follow that skill's setup and configuration workflow. Relative paths resolve within the skill directory.

For Feishu Message Server, Dot prepares configuration and runs the commands during the skill interaction. When working directly with its CLI, start from its directory:

```bash
cd skills/messaging/feishu-message-server
bash feishu.sh setup
bash feishu.sh prepare --config /path/to/config.yml
# Use the config path returned by prepare:
bash feishu.sh check --config /path/to/temporary/config.yml
bash feishu.sh start --config /path/to/temporary/config.yml
```

The required configuration keys are `app_id` and `app_secret`. Optional keys are `brand` and `bot_open_id`. Stop the listener with Ctrl-C and remove the temporary configuration when it is no longer needed.

## Validate and package

Run the checks provided by the skill before changing or moving it. The Feishu skill includes offline tests with mocked SDK responses and a local loopback HTTP fixture:

```bash
cd skills/messaging/feishu-message-server
bash feishu.sh setup
bash feishu.sh validate
bash feishu.sh test
bash feishu.sh package
```

The archive is written to `dist/feishu-message-server-node.tgz`. Its fixed manifest includes the skill's code, tests, blank configuration template, and documentation. Installed dependencies and runtime files stay outside the archive.

## Add another skill

1. Choose the best-fitting category and create `skills/<category>/<skill-name>/`. Use lowercase names separated by hyphens and keep skill names unique across the repository.
2. Add `SKILL.md` with a matching `name` and a concise description of when to use the skill. Keep instructions, examples, and CLI help in English.
3. Keep supporting scripts, templates, tests, and references inside the skill directory. Document its requirements, setup, configuration, commands, and expected results.
4. Use relative paths and blank or clearly illustrative configuration examples. Keep local configuration, logs, inbox data, installed dependencies, and generated archives out of tracked files.
5. Add a catalog section or row under the matching category in this README. Describe what the skill does and link to its entry point. Update the category map and layout when adding a new directory.
6. Run the skill's checks and verify that its directory works after copying it to another location. Record any remaining coverage limits with the skill.

Keep changes to unrelated skills separate so each directory can evolve and be reviewed independently.
