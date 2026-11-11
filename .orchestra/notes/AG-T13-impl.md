AG-T13 impl: apps/bridge-agent/internal/hostquery/client.go (E05 HTTPS client), relay.go (Relay.Handle, outcomes, 30 s fail-fast, key reuse per item).
[CONV] Client re-implements uploader.NewClient TLS rules (https-only, TLS>=1.2, no redirects, SPKI pins, proxy) because uploader's internals are not exported and not owned by this task. Idempotency-Key = uploader-style UUIDv7 (own copy), reused per ItemID until the item completes.
[CONV] Item rule (TRD 5.7): 200 / 4xx other than 401,429 -> MarkUploaded; transport error, timeout, 5xx, 429, 401, auth_state=rejected, budget exhausted -> pending + `host_query_unavailable` log + counter. Logged server codes must match [a-z0-9_.]{1,64} else `http_<status>`.
[CONV] Call timeout = ReplyTimeout-1s; reply expiry = CapturedAt+ReplyTimeout; stale = call took longer than ReplyTimeout (tests use a fixed CapturedAt, so staleness is measured from call start, not from CapturedAt).
Review fix 1: every unreachable result re-arms the 30 s fail-fast window (03-APP-FLOW §3.4 step 2); cleared on any server answer.
Open: Outbound.Enqueue has no real implementation yet (queue.outbound writer missing); Items is *queue.DB.MarkUploaded by assumption, not checked.
Verified: `go test -count=1 ./internal/hostquery/...` ok, go vet clean. NOT run: `-race` (no C compiler / CGO on this host).
