# Image and PDF replies

Use this workflow only when the user authorizes disclosing the specific file to
the originating Feishu conversation. Intake authority alone does not authorize
arbitrary file disclosure. Dot reviews the request and file scope with its actual
tools; scripts do not infer attachments from prose or download incoming files.

The direct Feishu connector accepts an optional `attachment_roots` array of
absolute authorized output directories in its reviewed settings. It defaults to
no upload access. Retain the existing `server`, `config_ref`, `state_dir`,
`account_id` and `brand` fields. Settings and module hashes remain immutable;
review a new binding through the existing connector upgrade procedure when they
change. Never rewrite a pinned hash, widen a root, or delete old grants/receipts
to bypass review. The selected resident must be running the matching version.

Attachment upload requires `upload: true` plus `inspectUpload`, `upload` and
`uploadStatus` methods. Remote Config Bridge does not advertise this feature;
it remains an operation/receipt bridge, not a file transport. This extension is
for files already on the direct service host. Do not put bytes or base64 into
bridge batches, task decisions or resident JSON. Use a separately authorized
official file-transfer workflow when the required file is on another computer.

## Upload, inspect, queue, deliver

Record/reuse the normal reviewed intake decision and task association first.
For bound tasks, keep the existing canonical text reply workflow. Publish each
attachment through this source-bound API once; it is a separate Feishu message
and does not create another task, mark completion, or mirror file bytes to dot.

```bash
taskctl attachment-upload --id report-pdf-upload --connector feishu-main --path "$PDF_PATH" --allowed-root "$AUTHORIZED_OUTPUT_DIR" --kind file --authorization-ref "$FILE_AUTHORIZATION_REF"
taskctl attachment-status --id report-pdf-upload
# Continue only when state is uploaded. INBOUND_ID is the scoped stored inbox ID.
taskctl attachment-reply --id report-pdf-reply --resource-id report-pdf-upload --inbound-id "$INBOUND_ID" --authorization-ref "$DISCLOSURE_AUTHORIZATION_REF"
taskctl deliver --consumer dot-active
taskctl outbox --all
```

`taskctl` abbreviates `node "$SKILL_DIR/scripts/taskctl.mjs" --store "$STORE_DIR"`.
Use `--kind image` for images. PDF is currently the only file-message type.
The transport rejects empty files, images above 10 MB, PDFs above 30 MB,
unsupported types, unsafe links and paths outside the selected root. The root
must exactly match an authorized `attachment_roots` entry. An upload inspects
the file on the service host, pins its SHA-256/size/name, and rechecks those bytes
before the actual multipart SDK call. Filename/content changes require a newly
reviewed upload, never mutation of an existing upload ID.

`attachment-reply` uses the stored source grant, account, connector binding,
chat and original `root_id` (or source `message_id`), with `reply_in_thread: true`.
It accepts no arbitrary destination. Task scope, enabled policy and account are
checked again during dispatch. Fixed-identity and all-sender grants retain their
existing source isolation. An accepted attachment receipt can resolve a later
reply back to the same canonical topic; it never grants action authority.

The upload call does not send anything. `attachment-reply` only enqueues;
`deliver` or the existing active `start` loop sends the immutable outbox entry.
Explain the result in short prose through the existing response API, with actual
paragraph breaks and reviewed `links` for sources; ordinary links render as
blue native Markdown text. No extra task or attachment heading is needed.

## Recovery and ownership

The optional `integration.json.uploads` array shares the existing task lock and
recovery journal. It stores upload ID, connector binding, app/platform, file
descriptor, authorization reference, durable `uploading` intent and independent
upload receipt. Upload keys are `upload-` plus 40 SHA-256 hex characters derived
from the logical upload ID and binding (47 characters). Outbox messages use the
existing `notice-` mapping (47 characters); the canonical long-key mapping stays
unchanged. Message receipts store the actual provider `message_id` separately
from `image_key`/`file_key`.

Repeated upload IDs return their saved result, including `uploading` after an
interrupted caller; changed input under the same ID is rejected. Concurrent
callers can create only one upload intent. For a lost caller result, use:

```bash
taskctl attachment-reconcile --id report-pdf-upload
```

This calls only the resident's read-only upload receipt lookup. An accepted
resource must match the original ID, digest, size, filename, kind, app and brand.
Missing/wrong keys or mismatched receipts remain `upload_unknown`. Reconciliation
does not reupload, send, or downgrade a previously stored successful receipt.
An upload intent without an authoritative resource key cannot be sent.

After enqueueing, inspect the existing outbox receipt. `delivery_unknown`
requires the normal authoritative `resolve-notice` process; do not blindly
repeat sends, allocate a different message key, or publish a second attachment
as a workaround. Replaying a message ID with a changed file/source/authorization
is rejected. Upload success does not prove message acceptance, reading, or task
completion. Preserve both task integration state and resident receipts when
upgrading. Existing scheduler state, five-second idle polling, current-message
`Get` acknowledgements and acceptance checks are unchanged.

## Connector methods

`inspectUpload({filePath,allowedRoot,kind}, {signal})` returns a bounded descriptor
with those fields plus `name`, `size`, `sha256` and `file_type: "pdf"` for files.
`upload({account_id,descriptor,idempotency_key}, {signal})` returns `status` and
the same key, with `resource` only on `uploaded`. The resource includes
`upload_id`, `app_id`, `brand`, `kind`, `name`, `size`, `sha256`, optional
`file_type`, and exactly the corresponding `image_key` or `file_key`.
`uploadStatus({account_id,idempotency_key}, {signal})` reads that same result.
Upload states are `uploaded`, `not_uploaded`, `api_error`, `upload_unknown`.
The normal message methods use `format: "image" | "file"` and
`body: {resource_id: UPLOAD_TRANSPORT_KEY}`; the Feishu adapter resolves the
durable key on the service host instead of trusting caller-supplied provider keys.

Repository tests cover binary SDK uploads, independent persistence/replay,
concurrent intent claims, read-only recovery, unknown-message protection,
revocation, source-topic correlation and renderer output. These are synthetic
checks. The parent dot must separately verify the upgraded cloud runtime,
connection, consumer, actual upload and actual threaded send when authorized.
