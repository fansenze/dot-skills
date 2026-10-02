# Bridge protocol and CLI

All commands use `node scripts/bridge.mjs`. Every argument is explicit; unknown options fail. JSON files are private runtime files outside the skill. Paths in command examples are placeholders.

## Binding

Public JSON fields: `remote_id`, `account_id`, `brand` (`feishu` or `lark`), `server_sha256` (64 lowercase hex). The local binding adds absolute `server`, `config_ref` and `state_dir` paths. `server` must be the actual reviewed Feishu Node entry point, not a shell command. Compute its hash with `hash --file PATH`. The entry-point pin does not cover imported dependencies: keep the whole reviewed server package and dependencies trusted and versioned. No job can change these paths, account or brand.

- `init-local --store PATH --binding LOCAL_JSON`
- `init-cloud --store PATH --binding PUBLIC_JSON --thread-id VERIFIED_TASK_ID`
- `status --store PATH`: counts/identities and result states; does not print secrets or message bodies
- `enqueue --store PATH --input JOB_JSON`
- `export --store PATH --output BATCH_JSON --limit 20`
- `process --store LOCAL_PATH --input BATCH_JSON --output RECEIPTS_JSON`
- `import --store CLOUD_PATH --input RECEIPTS_JSON`
- `show --store PATH --id JOB_ID`: full authorized job/receipt; may contain message content

Cloud and local stores use a single-host atomic JSON snapshot, fsync and a cross-process lock. Do not use shared network filesystems or manually edit snapshots. Lock acquisition waits approximately five seconds, then reports `Bridge store busy`. Local `process` holds its store lock across the bounded CLI invocation (up to 74 seconds per send), so another local command can legitimately report busy during that operation. Serialize worker batches through the reused child task; a busy result is not permission to rerun or reset a send intent. After the active operation ends, inspect its durable receipt and retry only the non-mutating lookup or the exact replay batch. Hard capacity is 32 MiB per store; no automatic pruning erases deduplication history. At capacity, preserve data and review migration instead of silently deleting jobs.

## Job shape

Input fields: `id`, `operation`, `payload`, `authorization_ref`. The bridge adds a public-binding hash and canonical payload hash. Supported operations are only `send`, `reply`, `receive`. No executable, arbitrary argument vector, script, config or shell field is accepted.

Send/reply payload: `account_id`, `destination:{id,type}`, `reply_to`, `format`, `body`, `idempotency_key`. `destination` is required for send; `reply_to` for reply. Formats are text, markdown and native card. Body is exact text or card object, bounded to 28,000 encoded bytes. Destination types are chat_id/open_id/user_id/union_id/email. Preserve provider idempotency keys exactly (1–50 ASCII letters/digits/underscore/hyphen).

Send/reply ID must equal `send-` plus the first 48 hex characters of canonical `hash(idempotency_key)` as exported by `core.mjs`. A reused ID with changed operation, body, account, destination, key, binding or authorization reference fails. Exact replay returns the saved receipt without another external call. The connector adapter derives the ID automatically from the task notice's existing key.

Receive payload: `cursor` (opaque string or null), `limit` (1–1000). Choose a fresh durable request ID for each new polling occurrence, even at the same cursor, because replay of an existing request intentionally returns its previous page. A failed read uses a new occurrence at the unchanged cursor; no messages are acknowledged or deleted. Save the cursor together with its exact binding/stream; never reset on a cursor error.

Batch shape: `{version:1,binding_hash,jobs:[...]}`. Maximum 100 jobs and 4 MiB per input/export. Process smaller batches for interactive delivery so a slow command does not exhaust another notice's lease. A receipt bundle is `{version:1,binding_hash,receipts:[{job_id,payload_hash,binding_hash,result,at}]}`. Exact imports are idempotent, conflicting imports fail. Receipt imports are allowed only from the verified local task; these hashes are consistency checks, not cryptographic sender authentication.

## Delivery semantics

Persist local `intent` before spawning the fixed Feishu CLI. Persist its normalized receipt before returning. Crash recovery with a send/reply intent and no receipt returns `delivery_unknown` and never respawns. The same applies to malformed, oversized, missing or timed-out CLI output. Safe provider rejections can be `not_sent` or `api_error`; the bridge still performs no automatic send retry. There is no retry/reset command that clears intent. Future explicitly authorized retries need a reviewed mechanism preserving the original key and provider deduplication limitations; do not work around uncertainty with a new job/key.

`api_accepted` requires actual successful API output plus a message ID and matching key. Only bounded diagnostic fields are retained. Raw stderr is discarded. Send/read processes have 74/14-second time bounds and 4-MiB stdout limits. Content crosses stdin, never shell expansion. Read jobs can be safely rerun after an interrupted intent, but an already persisted page is replayed exactly.

The current task connector loader supports local modules, so register this adapter by its absolute local module path, not an invented remote transport string. Settings JSON: `{"store":"/absolute/cloud/bridge-store","authorization_ref":"verified-user-approval-reference"}`. The adapter declares protocol 1 and maps Feishu inbox metadata to the existing task connector contract. It does not install a daemon or cause dot to wake by itself.
