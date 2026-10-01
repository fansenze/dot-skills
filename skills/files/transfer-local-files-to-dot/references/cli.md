# Filesystem CLI

Use Node.js 22.18.0 or newer with built-in modules only. No installation, Python, npm, shell tar, network service, or background process is required by this CLI. Official Library helpers have their own runtime requirements.

## Commands

- `pack --source ABSOLUTE_PATH --output NEW_ABSOLUTE_DIRECTORY`: produce `transfer.tar`, `manifest.json`, and private `receipt.json`. The parent directory must already exist. Source can be one file or one directory. To transfer several disjoint sources, run separately within the authorized scope and preserve the ordered Library upload batch.
- `verify --archive PATH --sha256 PRODUCER_SHA256 --bytes PRODUCER_ARCHIVE_BYTES`: verify the downloaded archive and all embedded payloads without writing outputs.
- `extract --archive PATH --sha256 PRODUCER_SHA256 --bytes PRODUCER_ARCHIVE_BYTES --destination NEW_ABSOLUTE_DIRECTORY`: verify first, then write and read back files in a new private directory. Existing destinations are never overwritten. Output uses restrictive local permissions, not archived permissions.
- `--help`: show usage and limits.

Successful commands output JSON and exit 0. Failures output one JSON object to stderr with `status: blocked`, `code`, and a useful message, then exit 2. Library authorization, upload, materialization, and network failures happen outside this CLI and must be reported separately by the orchestrator.

## Failure classes

| Code | Meaning and next action |
| --- | --- |
| `INVALID_ARGUMENT` / `UNSUPPORTED_RUNTIME` | Correct the invocation or use an available supported runtime |
| `SENSITIVE_PATH` | Stop before upload; review a narrower ordinary-file scope, never bypass the guard |
| `SYMLINK_REJECTED` / `UNSAFE_FILE` | Source contains a link or special file; do not dereference it |
| `SOURCE_CHANGED` | Source changed during packaging; obtain a stable source and repeat |
| `LIMIT_EXCEEDED` | Select a smaller authorized scope; fixed safety limits cannot be disabled |
| `UNSAFE_PATH` / `DUPLICATE_PATH` | Unsafe, nonportable, ambiguous, or duplicate path rejected |
| `INVALID_ARCHIVE` / `UNSAFE_ARCHIVE_ENTRY` / `INVALID_MANIFEST` | Wrong format, malformed archive, or unsupported metadata; do not use a generic extractor |
| `INTEGRITY_MISMATCH` | Receipt/archive/manifest/written bytes disagree; do not use the output |
| `DESTINATION_EXISTS` | Choose a new destination; there is no overwrite option |
| OS error / `IO_ERROR` | Preserve the exact failure; do not change permissions or bypass restrictions silently |

## Security and scope limits

The archive uses only regular-file and directory USTAR entries; no compression, PAX/GNU extensions, links, devices, owners, timestamps, or executable permissions. The first entry is `.dot-transfer-manifest.json`; every remaining entry must match its order, relative path, kind, size, and SHA-256, below exactly one root. Consumer input requires both expected archive bytes and SHA-256 from the producer, independently of the download.

The helper rejects common credential/configuration paths using metadata only. It does not inspect, interpret, or content-scan payload bodies, including YAML/JSON, binary files, or nested archives. Byte buffers are used only for packaging, transport preparation, checksums, and exact readback verification. CLI output contains metadata, counts, paths, and hashes; no payload body is printed or logged. The helper never redacts or changes payload bytes.

The invoking assistant must establish permission and the data category from metadata, user descriptions, and already-known context before upload. When context already identifies credential material, stop before packaging/upload even though the CLI does not scan it. If safety is unresolved, ask a narrow metadata/category question instead of reading bodies. A passing CLI check is not a sensitive-data classification or permission. Do not rename, encode, split, or modify prohibited material to bypass a guard.

Source snapshots are in memory and bounded by the fixed caps. Directory or file changes detected during reads abort packaging. Files are opened with no-follow flags and single-link checks. Existing parent paths are canonicalized for platform aliases; source leaves and archive entries never dereference symlinks. This protects ordinary stable task inputs, not adversarial concurrent same-account filesystem modification. Stop concurrent writers or use an already approved stable export.

No real user data, local machine configuration, credentials, or task records belong in this skill. Tests create synthetic temporary inputs and clean only those test-owned directories.
