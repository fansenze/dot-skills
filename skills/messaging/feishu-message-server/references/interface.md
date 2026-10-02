# Independent message-server interface (protocol 1)

The server receives, durably stores, sends and replies. It has no task model, task executor, command authorization grants or notification retry loop. Manage Dot Tasks calls this interface through its adapter; other consumers can use it without adopting that skill. No HTTP/MCP service is required.

## Capabilities and selection

```bash
bash feishu.sh capabilities
bash feishu.sh check --config "$CONFIG_FILE"
bash feishu.sh identity --config "$CONFIG_FILE"
```

`capabilities` returns `{protocol_version:1,name:"feishu-message-server",formats:["text","markdown","card"],send:true,reply:true,receive:true,durable_cursor:true,delivery_receipts:"api_acceptance_only",automatic_retry:false}` without loading configuration or calling the network. `identity` loads only the selected configuration and returns app ID/brand, never its secret. It does not prove network readiness or recipient ownership. CLI JSON version 1 is additive; consumers reject unsupported major versions and unavailable capabilities. Dependencies must be installed before invoking the server CLI. All commands run in the configuration’s actual environment. For dot orchestration of a user-computer configuration, follow [remote configuration](remote-configuration.md): local task tools own CLI execution; dot transports authorized batches and results.

Installation, `setup`, `prepare`, `init`, capability inspection, sending and inbox inspection do not implicitly start the receiver. `init` persists only when the user requested that configuration write; `prepare` uses a private temporary file. Reuse an existing selected config when no preparation is needed. Start/reuse a matching receiver only within startup authorization. Runtime data/configuration stay outside exported code.

## Explicit formats and results

```bash
# Content through stdin is supplied by the authorized caller.
bash feishu.sh send --config "$CONFIG_FILE" --expected-app-id "$APP_ID" --expected-brand feishu --receive-id "$CHAT_ID" --receive-id-type chat_id --format card --idempotency-key "$KEY" --stdin
bash feishu.sh reply --config "$CONFIG_FILE" --expected-app-id "$APP_ID" --expected-brand feishu --message-id "$MESSAGE_ID" --format markdown --idempotency-key "$KEY" --stdin
```

`text` (default) wraps exact Unicode in the SDK's text content. `markdown` constructs an interactive JSON 2.0 card with `body.elements:[{tag:"markdown",content:TEXT}]`; pipe tables are rejected, not converted to plain text. `card` accepts a JSON 1.0 object with an `elements` array or JSON 2.0 with `body.elements`. The server validates the envelope/size; the provider decides detailed card validity. Send a complete native card to preserve columns. No implicit fallback, truncation or retry occurs. Text remains backward compatible. Card/Markdown payloads share the 28,000-byte content bound. Idempotency keys are passed unchanged to the official SDK `uuid` field.

A success is `{ok:true,message_id:string,idempotency_key:string}` (API code zero plus actual message ID). It establishes API acceptance only. Failure returns `{ok:false,status:"not_sent"|"api_error"|"delivery_unknown",idempotency_key,...safe diagnostics}`. Authentication failure before message dispatch is `not_sent`; provider rejection is `api_error`; a timed-out/malformed/uncertain message response is `delivery_unknown`. `--expected-app-id` and `--expected-brand` mismatch is `not_sent` with `request_phase:"validation"` and `error_code:"binding-mismatch"` before networking. General parse/config errors may instead return an error/exit status without a delivery result: a consumer that persisted send intent must treat a missing valid result conservatively as unknown.

Safe diagnostics may include numeric `code`, `http_status`, `elapsed_ms` and allowlisted `error_type`, `error_code`, `request_phase`. Never store raw exceptions, headers or body dumps. Fixed timeout is 30 seconds per authentication/message request. The server never retries internally. A consumer must preserve account/platform, exact destination/type, body, reply target/options and key on any authorized retry. The provider's dedup window is finite; no permanent exactly-once guarantee exists.

## Durable inbox cursor

```bash
bash feishu.sh inbox-page --state-dir "$STATE_DIR" --limit 100 --show-text
bash feishu.sh inbox-page --state-dir "$STATE_DIR" --cursor "$CURSOR" --limit 100 --show-text
```

`inbox` is a recent-record UI, not a reliable event source. `inbox-page` opens `STATE_DIR/messages.sqlite3` read-only and returns:

```json
{"protocol_version":1,"messages":[{"cursor":"opaque-after-this-message","message":{"app_id":"fixture-app","tenant_key":"fixture-tenant","event_id":"fixture-event","message_id":"fixture-message","chat_id":"fixture-chat","chat_type":"p2p","sender_open_id":"fixture-sender","sender_tenant_key":"fixture-tenant","message_type":"text","text":"/tasks list","content":"original-provider-content","bot_mention_keys":[],"received_at":1700000000}}],"next_cursor":"opaque-after-last-message","has_more":false}
```

The listed message metadata is the durable receiver record. `text`/`content` appear only with `--show-text`; non-text records have no inferred text. `message_created_ms`, status and trust metadata may also be present. `received_at` is receiver time in epoch seconds, not sender time. `bot_mention_keys` includes only placeholders matched to the authenticated/configured bot identity. Do not trust arbitrary mention claims.

Cursor is opaque to consumers (currently base64url `{stream,offset}`). Stream ID is generated once in SQLite metadata; monotonic sequence and message commit in the same `synchronous=FULL` transaction before SDK acknowledgement. Duplicate `(app_id,tenant_key,message_id)` or `(app_id,tenant_key,event_id)` inserts allocate no sequence. Pages use one read transaction and ascending sequence; every row carries the cursor immediately after it. The final cursor equals the last row, or the current initial/unchanged cursor when empty. Limit is 1–1000; `has_more` reflects that snapshot. New concurrent messages are read by the next page/cycle.

Persist an external consumer checkpoint only after its own durable processing. There is no server-side delete/ack operation; consumers have independent cursors. Task integration commits checkpoint, dedup and any response/schedule in one task journal. A process dying before commit rereads the same event. Keep cursor with its exact stream/state directory, account and adapter binding.

The current receiver migrates old compatible databases by adding cursor metadata without changing messages. A read-only consumer cannot perform migration. Missing store/metadata, a different stream, unsupported cursor, sequence gap or truncation returns an error; retain the checkpoint and investigate. Do not silently reset to latest or erase history. No retention/rotation operation is supported. Replacing a database requires an explicit reviewed new stream/consumer binding and replay scope; provider IDs remain deduplicated in the task store.

## Validation boundary

`tests/interfaces.test.mjs` exercises >1,100 backlog messages, restart, duplicate IDs, concurrent processes, migration, gaps/rotation, credential-free capability/inbox calls, account pins and actual SDK create/reply payloads with an injected HTTP adapter. Task connector tests exercise native column rendering and transactional message processing separately. These checks do not establish live Feishu/Lark permissions, recipient ownership, mobile/desktop card rendering, human reading, or new live connection readiness.

Official format references: [native columns](https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/column-set), [JSON 2.0 card structure](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure), and [Markdown component](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text).
