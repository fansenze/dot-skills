# Authorized image and PDF delivery

Upload a selected host-local file, persist its resource receipt, then send or
reply using that receipt. Uploading never sends a message. These commands reuse
the selected matching resident; they do not start a listener and have no
standalone fallback. The receiving path still stores attachment metadata without
downloading or interpreting it.

## CLI workflow

Use verified host-local paths and the actual original message ID. The directory
must be within the user's authorized file scope; never select the filesystem
root, configuration directory or a broader directory merely to bypass a check.
Keep files and their parent directories stable during inspection and upload.

```bash
# Read only, no credentials or network. Reports SHA-256, size and filename.
node "$FEISHU_SKILL/scripts/server.mjs" inspect-upload --path "$PDF_PATH" --allowed-root "$AUTHORIZED_OUTPUT_DIR" --kind file

# Persist upload intent before the SDK call; use image for a supported image.
node "$FEISHU_SKILL/scripts/server.mjs" upload --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" --path "$PDF_PATH" --allowed-root "$AUTHORIZED_OUTPUT_DIR" --kind file --idempotency-key report-upload-1
node "$FEISHU_SKILL/scripts/server.mjs" upload-status --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" --resource-id report-upload-1

# Only after uploaded, and only for the authorized audience and reply.
node "$FEISHU_SKILL/scripts/server.mjs" reply --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" --message-id "$SOURCE_MESSAGE_ID" --reply-in-thread --format file --resource-id report-upload-1 --idempotency-key report-message-1
```

Add `--resident-dir` consistently for a non-default resident. For a requested
new message, use `send --receive-id ID --receive-id-type chat_id` with the same
attachment options. `--format image` sends the uploaded image; `--format file`
sends the uploaded PDF. Each attachment is one message; send an independently
authorized caption through the normal text/card route. Both upload and attachment
message keys are explicit, stable, distinct and 1–50 ASCII letters, digits,
underscores or hyphens. Do not substitute a raw `image_key`/`file_key` for the
resident upload ID; its stored receipt establishes application/platform ownership.

Images support JPG/JPEG, PNG, WEBP, GIF, BMP, ICO, TIFF/TIF and HEIC, with a 10 MB
(10 × 1024² byte) upper bound. PDF files use `file_type: pdf`, a `.pdf` extension
and `%PDF-` signature, up to 30 MB. Empty files, directories, leaf symlinks,
hard links, paths resolving outside the authorized directory, changes between
inspection and upload, and unsupported types fail before uploading. The provider
still validates the actual image format and resolution (GIF up to 2000 × 2000;
other message images up to 12000 × 12000). No conversion is attempted.

The optional `--sha256` pins previously inspected bytes. The resident rechecks
size, name and digest and passes the bounded binary Buffer to SDK 1.74.0, which
encodes multipart/form-data. Only path/descriptor metadata crosses the existing
100000-byte resident JSON interface. Bytes and base64 never enter message JSON,
the task ledger or the operation journal. A message's provider `content` is a
JSON string containing only `image_key` or `file_key`.

## Durable boundaries and recovery

The resident journal separately stores the upload intent (descriptor, SHA-256,
size, filename, app ID and Feishu/Lark brand), upload receipt (resource key and
upload ID), message intent (immutable destination, format, resource ID, reply
options and message key), and actual message result/ID. Preserve the entire
resident directory and receiver state through restarts. A stored resource remains
usable without rereading the original file. The key belongs to that app/platform;
another account cannot adopt it.

`uploaded` confirms only a resource upload. `not_uploaded` means validation or
authentication prevented this upload attempt; `api_error` means explicit provider
rejection. Missing or malformed responses and interrupted uploads remain
`upload_unknown`. `upload-status` reads the journal without a provider call;
it can recover a successful receipt after a caller lost its response. An intent
without a resource key stays unknown. Repeating `upload` with the same key and
descriptor replays the stored result and never uploads again.

For messages, successful API acceptance still requires the actual `message_id`.
Unknown message sends never retry automatically, change keys or fall back to
another format or destination. Preserve prior unknown results even if a later
attempt fails before sending. Provider UUID deduplication lasts one hour; it is
not a substitute for the durable journal. A changed runtime can require reviewed
binding/reconciliation; do not delete receipts to make an upgrade send again.

## Permissions and official contracts

Upload needs either `im:resource` or `im:resource:upload`, plus enabled bot
capability. Sending needs the existing message permission and destination access.
Never expand permissions or send test messages just to install this feature.

Official references: [image upload](https://open.feishu.cn/document/server-docs/im-v1/image/create.md),
[file upload](https://open.feishu.cn/document/server-docs/im-v1/file/create.md),
[message creation](https://open.feishu.cn/document/server-docs/im-v1/message/create.md),
[thread reply](https://open.feishu.cn/document/server-docs/im-v1/message/reply.md).
SDK upload methods unwrap the resource data; the transport checks business errors
before that unwrap. Tests use the pinned real SDK with synthetic HTTP responses
and loopback resident fixtures, never real credentials or live Feishu delivery.
