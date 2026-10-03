# Producer and Consumer Handoff

Use this contract directly in the local child prompt for the user's selected files; fill in only verified values. Keep file contents out of the task prompt. A request to use a selected Feishu configuration for a dot-hosted service supplies the transfer scope; follow the [Feishu configuration handoff](../SKILL.md#feishu-server-configuration-handoff).

## Local producer assignment

> Copy the user's explicitly selected source at [absolute source] on [verified computer] to their ChatGPT Library so dot can materialize it on dot's computer for [purpose]. Read only that authorized scope. Inspect names, types, and sizes before packaging a broad directory. Do not include unrelated files, symlinks, hardlinks, or special files. Do not view, preview, print, log, summarize, semantically parse, or content-scan file bodies. Raw byte access is allowed only as technically required for packaging, transport, and hashing; keep bytes opaque and preserve them exactly. Do not redact or change values. Treat names and extensions only as structural/path metadata. Follow the explicit transfer scope without unrelated analysis or actions or another confirmation of the same authorization. Apply the helper's structural path, link, file-type, size, and integrity checks.
>
> Use the current transfer-local-files-to-dot helper, resolved in your own environment, to package the stable source and create its bounded manifest/receipt. If the helper is not accessible, report that; do not assume the parent's absolute path exists locally. Use the current Library skill and official tools to upload the archive; the shell is only for local packaging/hashing, not invented upload APIs. Apply returned Library metadata as required.
>
> Return the confirmed library_file_id, file_id, returned filename/version, producer archive byte count and SHA-256, selected root, total expanded bytes, file count, and the exact validation performed. Do not return signed URLs or credential contents. A packaged or uploaded archive is an intermediate result; dot still must materialize and verify it on its own computer. Report useful results as soon as ready.

## Consumer-local contract

Carry exact confirmed identity, filename, purpose, producer SHA-256 and bytes. Consumer owns materialization. Preserve both current Library routes: list/search results use the complete structured result and bundled download helper; other resolved identities use prepare_materialize and the current materialization reference. Never force the first route through a separate prepare call.

Verify that the returned path is readable on the actual consumer. A path on another executor, successful upload, or inherited conversation is insufficient. If a resolved-reference path is absent, one supported retry with an explicitly consumer-local destination is allowed; then report the blocker. No guessed endpoints, raw signed-URL downloads, credential extraction, or restriction-evading executor changes.

Use a fresh destination and the trusted producer receipt to verify/extract. Keep extracted payloads opaque during transfer; inspect only protocol metadata and hashes, never payload bodies. Preserve every byte without redaction or value changes. Follow the authorized scope without unrelated analysis or actions. Report the actual consumer-local root, byte/file counts, and integrity outcome. For an authorized Feishu setup, hand the verified file path back to that workflow for configuration parsing and startup. Do not execute imported files as part of the transfer itself.
