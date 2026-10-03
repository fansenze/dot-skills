Manage Dot Tasks with Feishu Message Server (connector protocol 1)

This archive contains three complete independent skills: manage-dot-tasks,
feishu-message-server and remote-config-bridge. It is not an installed service.
Start with manage-dot-tasks/SKILL.md and its references/startup.md.
Use references/connectors.md for the command and transport contract. The agent wires
the direct Feishu adapter for a service on dot with a dot-local configuration,
or the bridge adapter only for explicitly requested computer hosting.
Configuration source location does not choose the service host. For dot hosting,
transfer the user's selected configuration through the internal Library skill,
verify its bytes on dot, and use the received path. Verify the requested version and pin the actual runtime
roots before setup or reuse. The user writes no glue code.
The server remains a transport and does not interpret task commands.

Requirements: Node.js 22.18+; Feishu dependency installation uses pnpm 11.27.0.
Put the verified pnpm bin directory first on PATH for every call and verify
child-process lookup too; a direct pnpm.cjs invocation alone is insufficient.
Task and bridge runtime/tests need only built-in modules. In feishu-message-server run:
  bash feishu.sh setup
  bash feishu.sh validate
  bash feishu.sh test
The generated standalone pnpm-lock.yaml preserves pinned workspace resolutions.
No credentials, real configuration, inbox, task store or node_modules are included.
Setup installs dependencies only; it never starts a listener or sends messages.

In manage-dot-tasks run:
  node --test tests/*.test.mjs
  node scripts/taskctl.mjs --help
To include the cross-skill read-only fixture, set FEISHU_SKILL_PATH to the absolute
companion directory after its dependencies are installed.

In remote-config-bridge run node scripts/validate.mjs and node --test tests/*.test.mjs.
The bridge keeps config/credentials/transport on the selected computer and uses
actual agent task tools for authorized operation batches/results, not arbitrary
file bytes. Reviewed code distribution may still need supported file transfer.

MANIFEST.json records exact file sizes, SHA-256 hashes and source revision metadata. Verify it after extraction.
The combined package can be rebuilt using scripts/package-with-feishu.mjs and the
absolute Feishu and optional bridge paths. Output must be outside all three
source directories.

Keep private runtime/configuration outside the exported directories. Only start
servers/consumers and authorize notification/inbound scopes actually requested by
the user. Active consumption depends on dot's running tool calls and permissions;
it cannot wake an inactive dot. Unknown message delivery is never auto-retried.
Local tests use synthetic stores, SIGKILL crash fixtures and mocked transport.
Live Feishu rendering/delivery/receiving needs separate authorized acceptance.
