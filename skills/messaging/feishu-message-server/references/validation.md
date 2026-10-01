# Validation record

Validation date: 2026-10-01. Current runtime: Node.js 22.18.0, pnpm 11.27.0, and official Node SDK 1.74.0. Earlier migration checks used npm 10.9.3.

| Area | Result |
| --- | --- |
| Automated tests | 65 passed through the root `pnpm check` command with test configuration, mocked SDK responses, and a local loopback HTTP fixture |
| Configuration initialization | Required and optional fields, default Feishu, explicit Lark, field precedence, and existing-file handling passed |
| Temporary configuration | YAML/JSON copying, values supplied through stdin, completing missing fields, preserving the source, and startup with temporary configuration passed |
| Missing-configuration checks | Results contain only status and missing key names; YAML/JSON, empty values, aliases, and calls from another working directory passed |
| Receiving | Private messages are stored directly; group messages mentioning this bot are stored; other group messages are ignored |
| Local storage | Deduplication across restarts, transactional writes, failure handling, and existing-database compatibility passed |
| Sending and replying | Mocked SDK arguments, success, failure, unconfirmed delivery, and idempotency keys passed |
| Proxies and CLI | Environment proxies, NO_PROXY, calls from another working directory, and shutdown handling passed |
| Skill validation | Metadata, dependency pins, the shared lockfile importer, and all 17 skill source files passed; the standalone archive contains 18 files including its generated lockfile |
| English content | Skill instructions, reference documents, template comments, metadata, and CLI help are in English; no Han characters remain in the skill source files |
| Migration | An earlier archive was extracted into a new directory; all 82 locked packages installed offline, and validation and startup help passed |
| Updated archive | Extracted again into a temporary directory using the already installed locked dependencies; file equality, validation, English help, YAML/JSON preparation, missing-key checks, Feishu/Lark selection, and calls from another working directory passed |
| pnpm monorepo | One root lockfile covers two workspace projects; all 78 unique dependency versions match the previous npm lockfile; a frozen root install and wrapper setup from another working directory passed |
| Standalone pnpm archive | Generated a single-importer lockfile, installed all 78 packages offline into a fresh directory, and verified validation, CLI help, configuration preparation, missing-key checks, Feishu/Lark selection, and an unchanged frozen lockfile |
| Local-data exclusion | Portable files exclude local configuration values, logs, inbox records, and original machine paths |

## Live verification

- 16:12 (UTC+08:00): the Node server connected and the SDK readiness callback succeeded.
- 16:18: one group message mentioning the bot and one private message without a mention were stored. Chat types and content matched the test messages.
- After the user enabled sending permissions, one distinct test message was sent to each of the requested private and group chats. Both succeeded with different message IDs.
- The initial `99991672` sending error was resolved by enabling the corresponding permission.
- 17:30: the updated English skill started with a configuration produced by `prepare`. Distinct private-chat and group-chat test sends both succeeded.
- 17:50: the updated instance stored a group mention and a private message without a mention in the expected chats. The user then requested shutdown; process exit, lock release, and temporary-configuration cleanup were confirmed.

This record preserves verification outcomes without including actual configuration values, chat identifiers, or message bodies. API success confirms that the send request was processed; it does not establish that the recipient read the message.

## Coverage limits and current scope

The reply endpoint has passed simulated tests but has not received a separate live reply test. Outgoing messages support text; non-text incoming messages retain their raw content. The server runs as a foreground process and does not automatically install a system service, reply, or execute tasks.

The current configuration entry point is `prepare`: copy or generate a temporary configuration in the actual execution environment, then immediately use its returned path with `start`. Missing-key detection and startup with temporary configuration have simulated coverage; `check` remains a diagnostic command. The skill installs and invokes `transfer-local-files-to-dot` when the selected configuration must move from the user's computer to dot. This orchestration change has not received a live Feishu configuration transfer or listener restart; local tests do not establish cross-machine transfer or connection readiness.

The English-content revision also fixed entry-point detection through symlinked directories, including macOS temporary-directory aliases. The full suite passed after adding a regression covering CLI help, missing configuration, and packaging through a directory symlink. The final archive was rebuilt and its complete file manifest and contents were compared with the source. No additional live messages or listener restarts were used for this revision.

The pnpm migration retained the direct and transitive package versions, removed the per-skill npm lockfile, and added root workspace commands. Runtime message handling was unchanged. Its verification used local fixtures and an offline standalone installation; no additional Feishu authentication or messages were needed.
