# Validation and coverage

## Runtime and synthetic checks

The filesystem CLI requires Node.js 22.18.0+ and uses built-in modules only. Validation and packaging also run without installing dependencies. Official Library helpers have their own runtime requirements.

The imported source revision passed 60 synthetic tests on Linux. On macOS with Node.js 22.18.0, 59 tests passed and one was skipped because the filesystem cannot create siblings whose names differ only in case. The archive-level case-collision test runs on both platforms. Windows has not been exercised on a real host.

The suite covers exact binary byte preservation, unchanged source files, metadata-only CLI output, deterministic archives, Unicode paths, empty entries, fixed size and depth limits, no-overwrite behavior, symlink and hardlink rejection, sensitive path rejection, malformed headers and manifests, traversal, duplicate paths, unsupported archive entries, and integrity failures. Synthetic payload fixtures are fabricated test data.

Run validation and tests from this skill's directory:

```bash
node scripts/validate.mjs
node --test tests/*.test.mjs
```

From the repository root, use `pnpm check`. The root CLI shortcut is `pnpm transfer --help`; `pack`, `verify`, and `extract` use the arguments documented in [cli.md](cli.md).

## Standalone export

Run `pnpm package:transfer` from the repository root. The default repository command writes `dist/transfer-local-files-to-dot.zip`. It contains an explicit allowlist of skill instructions, UI metadata, the icon, Node scripts, references, and synthetic tests. Runtime packages, receipts, user files, Library helpers, dependency directories, and local configuration are excluded.

For an extracted or standalone copy, use:

```bash
node scripts/package.mjs /path/to/transfer-local-files-to-dot.zip
```

The deterministic ZIP uses the same file order and metadata on each run and needs no standalone lockfile. Extract it into a separate directory, then run its validation and tests with Node. The exported copy includes the exporter itself.

## Boundaries

Local tests and export checks verify the filesystem mechanics. They do not establish a successful transfer between the user's computer and dot. End-to-end acceptance requires actual consumer-local bytes, the independently supplied producer archive hash and size, successful safe extraction, and per-file verification.

A real macOS-to-dot transfer of one user-selected file was separately accepted through official Library upload and materialization. The producer and consumer archive sizes and hashes matched, and safe extraction verified the received file's exact bytes. Neither side interpreted, displayed, or modified that payload. This validates the tested single-file route; other hosts and larger real transfers remain unverified.

Payloads remain opaque. The assistant must use metadata, user descriptions, and existing context to establish scope and safety; the helper does not inspect content or classify sensitive data. Known credential-bearing sources remain blocked. No real test payloads, personal paths, credentials, or task receipts belong in this skill or its exported archive.

Source trees must remain stable. The helper does not isolate against another process with the same account modifying paths concurrently. Executable bits, ownership, timestamps, extended attributes, and resource forks are intentionally not preserved.
