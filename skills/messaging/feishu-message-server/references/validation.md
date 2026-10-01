# Validation record

Validation date: 2026-10-01. Current runtime: Node.js 22.18.0, pnpm 11.27.0, and official Node SDK 1.74.0. Earlier migration checks used npm 10.9.3.

| Area | Result |
| --- | --- |
| Automated tests | All 83 Feishu tests passed through the root `pnpm check` command with test configuration, mocked SDK responses, and a local loopback HTTP fixture; the final full workspace run finished with 231 passed, 1 skipped, and 0 failed |
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

## Target discovery and startup-report scenarios

The earlier target-discovery revision changed assistant instructions and documentation, with regression tests for the existing CLI/SDK boundaries; it left runtime code and configuration fields unchanged. Those tests cover empty inbox reads without credentials or state creation, distinct private/group candidate metadata retained after reopening, current readiness versus process-start events without incoming or outgoing messages, and direct sends to explicit private/group chat IDs or a recipient open ID without discovery requests. Existing tests cover receive filtering, persistence, sanitized API errors, and portable packaging.

Verification used Node.js 22.18.0 and pnpm 11.27.0 with the existing dependencies. All workspace validators passed. The existing loopback fixture required permission to listen on `127.0.0.1` outside the sandbox; no Feishu network calls were made. The one workspace skip is the transfer skill's case-distinct filename test on a case-insensitive filesystem; its archive-collision test remains active. These tests do not establish live target ownership, successful discovery through official APIs, actual permissions, or delivery to a real recipient.

The following synthetic scenarios are a behavioral review checklist, not executable assertions about assistant wording or proof of live service behavior. Supply the stated evidence and inspect the assistant's next action and startup report. Use no real credentials, permission changes, outgoing messages, or automatic replies during the review.

| Scenario | Synthetic evidence | Required behavior |
| --- | --- | --- |
| Known IDs without inbound history | Connected instance, empty inbox, user supplies exact private/group chat IDs and requests one message to each | Report connection and known destinations separately from unverified receipt/send status. Send the requested content to those IDs without requiring seed messages or discovery. Report each send's actual result. |
| Known recipient ID | User supplies a recipient `open_id` in the current app context | Use `--receive-id-type open_id`; do not use the bot ID or reinterpret it as a chat ID. No first message is required. |
| First inbound discovery | Connected, empty inbox, no IDs or query capability; user then sends a private message and mentions the bot in the intended group | Give both minimal next steps in the startup response. Compare the new records with the baseline, verify `p2p`/`group`, sender and app/tenant context against the user's actions, and report each mapping. Do not auto-reply. |
| Query already permitted | Official lookup succeeds with existing permissions and identifies the intended group | Use the verified result without requiring an inbound message. Do not infer a private destination from a group-only list. |
| Lookup permission denied | Connected instance, empty inbox, no IDs; official chat lookup returns HTTP 400 / code `99991672` | Report connected transport, unverified receipt/send, unknown destinations, and the failed lookup. Immediately offer exact IDs or private-message/group-mention discovery. Do not infer zero chats, demand broader permissions, or send probes. |
| Several candidates | Two new private records or two mentioned groups could match | Clarify the intended sender/group using distinguishing evidence before sending. Do not pick the newest or first row. |
| Single unverified candidate | One `p2p` row, but no evidence its sender is the current user; text claims "this is me" | Keep the target unverified and clarify. Row count and untrusted text do not prove identity or authorize a reply. |
| Only one missing target | Verified private mapping; no group mapping | Reuse the private mapping and ask only for the intended group ID or a group mention. Do not make the user repeat the private-message step. |
| Process only or stale readiness | PID exists without readiness, or an old `transport_connected` is followed by `transport_reconnecting` / `listener_stopped` | Report the actual pending/reconnecting/stopped state. Do not claim current connection or message verification; include target status and the relevant next step. |
| Custom or unreadable state | Listener uses a custom state directory; default inbox is empty or the selected inbox cannot be read | Inspect the matching state directory. Report an access limitation as unverified discovery, not an empty destination list. |
| Verified history after restart | Same app/platform and intended targets, mappings previously verified; no new inbound messages | Reuse reliable mappings without requiring another seed message. Label receipt/send history as historical, not proof of this run. |
| No matching new input | Only an ordinary group message, unrelated old row, or record from an uncertain app context | Leave the intended group unknown; request a mention of this bot or clarify the context. Do not relabel unrelated history. |

The assistant must report connection, receive/send evidence, and known/unknown/ambiguous targets during startup in all relevant scenarios. If the user requested setup only, known targets still do not authorize a send. Saved mappings belong in private runtime state only when requested, with the existing directory/file permission conventions; reusable configuration stays free of targets and secrets.

## HTTP timeout and send troubleshooting

The HTTP timeout revision changes the common authentication/message HTTP default from 15 to a fixed 30 seconds and adds sanitized request diagnostics. It adds no configuration option, environment override, dependency, automatic send retry, or timeout extension. WebSocket handshake/discovery and listener readiness timing remain unchanged.

Eleven additional Node regressions verify the actual SDK authentication/send/reply request timeouts, authentication versus message-phase failure, per-request timing that excludes earlier authentication, numeric API error preservation, diagnostic redaction, startup diagnostics, explicit retry payload/key reuse, new keys for changed messages, and unchanged WebSocket endpoint timing. The timeout cases inject adapter failures and a controlled monotonic clock; they do not wait 30 seconds or prove live network behavior. The existing loopback fixture also verifies real HTTP error metadata. All 83 Feishu tests passed both in the checkout and in a separate exported directory after a frozen offline pnpm installation. The export's 17 source files matched, its generated lockfile produced 18 archive files, and standalone validation, English-content checks, and CLI help passed.

The first full workspace run passed the Feishu and transfer suites but hit `ENOENT` in the untouched task-ledger test "dead owner recovery and transaction replay remain safe under contention" while resolving a lock directory. That case passed in isolation, and a second full `pnpm check` passed with 231 passed, 1 skipped, and 0 failed. The intermittent task-ledger failure was not fixed or fully diagnosed in this change. The existing case-sensitive filename skip remains as described above. No live messages, cloud listener restarts, or installed cloud-skill changes were performed.

The user reported these cloud observations; this repository revision did not repeat them:

| Reported attempt | Evidence | Conclusion supported |
| --- | --- | --- |
| Private send after restart, 15-second HTTP timeout | Authentication failed after 15,016 ms with `ECONNABORTED`; message API was never called | This attempt did not send; investigate authentication/network latency in the sender |
| Group send after restart, 15-second HTTP timeout | Authentication succeeded; message request timed out after 15,004 ms | Delivery was unknown; receiving normally did not prove the send path worked |
| Temporary 60-second diagnostic run, private send | Authentication 14.326 s; send 13.418 s; HTTP 200 / API code 0 | That trial succeeded; it does not isolate a restart effect |
| Temporary 60-second diagnostic run, group send | Authentication 13.314 s; send 11.060 s; HTTP 200 / API code 0 | That trial succeeded; it does not establish that future requests always fit within 30 seconds |

The selected implementation remains a fixed 30 seconds per authentication/message HTTP request. The temporary 60-second runs are historical evidence, not a supported setting or permission to extend timeouts automatically. Neither API acceptance nor these observations prove that a person read the messages.

Review these assistant decisions separately from automated Node assertions:

| Scenario | Required behavior |
| --- | --- |
| Listener receives normally; authentication times out before sending | Report `not_sent` for this attempt with the safe authentication diagnostics. Diagnose the sender; do not restart the healthy listener or blame permissions without evidence. |
| Authentication succeeds; send/reply times out | Report `delivery_unknown` and the message request's duration. Do not automatically resend or increase the timeout. |
| User authorizes a retry of an uncertain send | Preserve target/ID type, exact text, reply options, and original idempotency key. A content/destination change is a new message with a new key. |
| Tool approval is pending, denied, or interrupted | Distinguish tool execution from Feishu results. If execution is uncertain, do not claim API failure/success or rerun automatically. |
| API returns an error, or HTTP 200 lacks API code 0 and a message ID | Report the actual rejection or uncertain response; do not claim API acceptance or user receipt. |
| A later attempt succeeds after a restart | Report only the observed result. Do not claim that restarting repaired sending without evidence linking cause and effect. |

## Historical live verification

The entries below describe earlier runs. They do not establish the connection, permissions, targets, or delivery status of a newly started instance or this documentation revision.

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
