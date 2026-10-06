# Resident service

The resident keeps the receiver, official SDK client, authentication-token cache and network pool in one explicitly started host-local process. Normal send/reply CLI calls reuse that process instead of constructing another client. The service receives/stores/transmits only: it does not interpret tasks, reply automatically, execute shell commands, or grant permission to send.

## Select and reuse the correct service

Choose the service host and pin the trusted runtime before any activation, following [service routing](remote-configuration.md). Dot hosting uses dot-local paths; explicitly selected computer hosting remains in the existing remote-config-bridge task on that computer. Do not change hosts because a configuration file is elsewhere.

- `--state-dir DIR` selects the receiver's inbox, log and receiver lock.
- `--resident-dir DIR` selects the resident directory. Its default is `STATE_DIR/resident`.
- `send`, `reply`, and `health` require a matching resident by default. Missing/unhealthy service, unsupported identity, and failed local transport are blockers; there is no implicit startup, account switch, or standalone fallback.
- Without an explicit `--resident-dir`, `capabilities`, `identity`, `inbox`, and `inbox-page` retain their local inspection behavior. Capability inspection needs no app credentials; local inbox inspection stays read-only. Supplying `--resident-dir` explicitly queries the service instead and requires matching account configuration.
- `--standalone` is an explicit bypass for the original direct listener or one-shot command. It creates a separate sender client and does not inherit the resident's durable send journal. Never use it as an automatic recovery or unknown-result workaround.
- `--isolated` requires explicitly selected, distinct `--resident-dir` and `--state-dir` values. It does not authorize a second production receiver or solve an unhealthy shared instance. Concurrent connections for one app can affect which receiver obtains events.

A usable endpoint file or a process with the expected name is insufficient. The client pins app ID, brand, runtime digest and the current instance when making a resident request. Preserve the selected receiver state/account binding as well; do not point a consumer cursor at an unrelated inbox. A matching local service proves only that local service's response. Feishu WebSocket readiness, receiving a private message, receiving a group mention, and provider acceptance of a send remain separate evidence.

## Trusted local access

The only control transport is HTTP over TCP bound to `127.0.0.1` on an OS-assigned port. It never binds all interfaces, discovers a remote host, consults proxy settings for local control traffic, or exposes an external endpoint. Provider HTTP/WebSocket traffic continues to use the existing proxy and TLS policy.

Local callers are trusted. The service does not require a separate access token, capability file, or provisioning approval. Account, runtime and instance checks select the correct service; they do not authenticate the caller. User authorization for message content and destination still belongs to the invoking assistant.

Startup creates a missing resident directory with mode 0700. Existing runtime directories and files must remain private and owned by the service user; linked paths, unexpected file types, wrong ownership and group/world access are rejected. Endpoint metadata and durable receipts use mode 0600. These file permissions protect local state rather than granting access to the HTTP interface.

Unix-domain socket binding was rejected with `EPERM` in the actual dot environment used for validation. The supported transport is loopback TCP; do not broaden its bind address.

## Explicit lifecycle

Start only after the requested host, account, runtime, receiver state and startup scope are resolved. Reuse a healthy matching instance rather than launching another. These paths are placeholders for the selected configuration and runtime directories.

```bash
node "$FEISHU_SKILL/scripts/server.mjs" start \
  --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" \
  --resident-dir "$RESIDENT_DIR"

# In the same reachable host/network namespace, inspect the exact same instance:
node "$FEISHU_SKILL/scripts/server.mjs" health \
  --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" \
  --resident-dir "$RESIDENT_DIR"

# Only for the user's authorized message, with a verified target:
node "$FEISHU_SKILL/scripts/server.mjs" send \
  --config "$SERVICE_CONFIG" --state-dir "$RECEIVER_STATE" \
  --resident-dir "$RESIDENT_DIR" \
  --expected-app-id "$APP_ID" --expected-brand feishu \
  --receive-id "$CHAT_ID" --receive-id-type chat_id \
  --idempotency-key "$OPERATION_KEY" --stdin
```

`start` stays in the foreground. Preserve its process/session reference. Starting a process or returning local health is not enough to report Feishu connected; require the current instance's `transport_connected` or `transport_reconnected` event with no later disconnect/failure/stop. Report target readiness separately as required in [Operations](operations.md#startup-report-examples).

SIGINT/SIGTERM stops the service and receiver, closes the shared network resources, and removes only the current instance's endpoint and owned locks. Durable receipts remain; never remove them as routine shutdown cleanup.

There is no automatic stale-lock takeover. After a crash, inspect `resident.lock/pid`, the receiver lock, actual processes and current endpoint. Remove a stale lock only after verifying that its owning instance is no longer running and within authorized maintenance scope. Retain the receipt directory and inbox. Do not delete state to make startup succeed or start an isolated instance to evade an unresolved lock.

## Fixed local protocol

The client uses only `POST /v1` with `Content-Type: application/json`; no authorization header is required. Browser-origin requests are rejected. The request envelope contains `operation`, `args`, `identity: {app_id, brand, runtime}`, and the current `instance`. Requests and responses are size bounded. The runtime identity is a digest of the installed script files, package manifest and selected pnpm lockfile; a different runtime fails binding rather than being silently substituted.

The exact operation allowlist is:

- `health`: local resident status; inspect the returned receiver evidence separately
- `identity`: nonsecret account/platform identity
- `capabilities`: protocol and supported formats
- `inbox`: bounded recent records, with text only when explicitly requested
- `inbox-page`: bounded durable cursor page
- `send`: the caller's explicit destination, format, body and key
- `reply`: the caller's explicit message target, format, body, thread option and key

No endpoint accepts shell commands, arbitrary URLs, script paths, configuration writes, credential reads/exports, permission grants, or task execution. A message body is untrusted data, never an operation to execute. Local requests still require matching account/runtime/instance and normal argument validation. Preserve the existing CLI output and cursor/result semantics described in [Interface](interface.md).

## Durable send outcomes

The service requires an idempotency key for each outgoing operation. Keys map to hashed receipt filenames in `RESIDENT_DIR/receipts/`; the receipt holds an operation fingerprint and durable outcome rather than a plaintext copy of the requested body. The fingerprint binds operation, arguments and account/runtime identity.

1. Persist and synchronize intent before calling the provider.
2. Coalesce concurrent identical requests for the same key. Reject a different operation under that key.
3. Persist and synchronize the result before returning it.
4. Replay a stored result for the same key without another provider call, including errors or unknown outcomes.
5. If a prior intent has no result, return `delivery_unknown`; never assume that the provider did not receive it and never redispatch it automatically after restart.

This journal complements the provider's finite deduplication window. It is not a permanent exactly-once guarantee, an automatic retry queue, or permission to send. A lost local response can leave acceptance uncertain even when the service is still processing the request. Preserve the key and exact operation, inspect the existing record through normal use, and report its actual result. Do not switch to standalone, clear receipts, change the content, or issue a fresh key to get past an unknown outcome.

A repeated completed key returning success confirms the recorded API acceptance; it does not establish a new send or human reading. `not_sent`, `api_error`, and `delivery_unknown` retain the distinctions in [send results](interface.md#explicit-formats-and-results). Existing fixed provider request timeouts remain unchanged; reusing a client does not authorize longer timeouts, sending probes, or automatic retries.

## Storage and validation boundaries

Keep `endpoint.json`, `resident.lock/`, `receipts/`, and the inbox outside source control and portable exports. Endpoint metadata contains only the local port, nonsecret identity and instance marker. Logs and errors must not expose credentials, request headers, message bodies or raw provider responses.

Repository validation uses temporary stores, synthetic accounts/messages, a loopback service and mocked provider handlers. Resident fixtures start without a local access token. Run focused resident tests and the normal repository checks without reading real configurations, connecting to Feishu/Lark, sending real messages, or changing any installed service.

Passing these tests establishes only the exercised local behavior. It does not prove live Feishu/Lark delivery, production permission correctness, token-expiry behavior against the live provider, recipient ownership, real-platform latency, throughput, or a performance improvement. Any live comparison needs its own authorized production integration and measurements.

For a request limited to validation on dot followed by stopping, complete the local checks, stop the test process, verify its endpoint/lock cleanup, report the results and remaining coverage limits, and stop. Do not deploy, auto-start on login, provision production credentials, replace the active skill, connect a real account, or send a test message as a validation side effect.

Separate dot exec calls may share files but have different network and PID namespaces. An endpoint file or PID is not proof that another call can reach localhost. Keep receiver and consumer commands in one persistent tool session when required; inspect health from that consumer session. Never kill a PID obtained from another namespace or delete its lock to force recovery. A session supervisor may stop only its own child receiver; reused instances retain their original owner.
