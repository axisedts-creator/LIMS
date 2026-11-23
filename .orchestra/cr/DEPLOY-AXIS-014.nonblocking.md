Title: CR-C1-DEPLOY-014: report QR verification answers 500 for any token; ops TCP probes still target the pre-move VM address
From chunk: C1 (deploy attempt, prod-lean, 2026-11-23; found while switching the monitoring targets to the public names)    To owner: per item (listed below)
Type: bug
Blocking? no for any current orchestra task (file named `.nonblocking`); item 1 matters before real report PDFs with QR codes are issued.
Relation to earlier CRs: CR-012 (live screen sweep), CR-013 (mobile app); this CR covers one api operation and the deploy monitoring inventory.

## Evidence from the host
Test host, api r9 (api-a, api-b), 2026-11-23 11:34-11:36 UTC, public origin `https://api.metrolmis.com:8443` behind the edge.

### 1. `verifyReportQr` answers 500 `common.internal` with zero database calls  (To: C6 reporting; C16 portal) (verified in the api log, cause not yet found)
Problem: every 30 s the Prometheus blackbox probe requests `https://portal.metrolmis.com:8443/v/invalid-probe-token` (the R3 uniform-response probe). The portal page answers 200 (the probe passes), but the api call behind it, `POST /v1/reporting/verifications` (operation `verifyReportQr`, module reporting), answers `500 common.internal` in 1-4 ms with `db_count` 0 and `db_ms` 0 on every request (examples: request ids 01a2082f-6773-79b2-bc32-e5c282e5f6dc, 01a2082f-dca9-718a-b38e-2b0905c6646a, 01a20830-51d2-7ca3-8451-94097fe0f7c2, 01a20830-c707-7e02-a17d-babc5a467cee, 01a20831-3c35-772a-b9cb-c0f24abf97f5). An invalid token should produce the uniform "not valid" outcome (R3), not a server error, and nothing should fail before the database lookup. The failure happens before any query, so it is most likely a missing configuration or key (for example the QR/verification signing or HMAC key file, or a resolver) rather than bad data.
Impact: the public report-QR verification page cannot verify any report on this deployment (a patient or third party scanning the QR on a printed report would see a failure or an error page), and every probe adds an error line to the api log.
Proposed change: find the exact `common.internal` source in the verifyReportQr path (the handler swallows it into a bare 500) and log a non-secret reason; add the missing wiring/configuration to the deploy (and a boot-time check that refuses to start without it); return the uniform invalid response for an unknown token; add an integration test that boots the real app and posts an invalid token and a valid one.
Backward compatible? yes.

### 2. The ops stack TCP probes still target the VM's pre-move address  (To: C1 deploy/ops)
Problem: 13 blackbox TCP targets (ports 22, 2222, 2020, 3128, 5000, 5432, 5433, 6432, 8081, 8090, 9100, 9187, 9188) are rendered against `192.168.100.245` (the inventory `public_ip`), which is no longer an address of the VM after the move to the office LAN (2026-11-23: VM 192.168.1.73, WireGuard 10.77.0.11). All 13 report `probe_success 0` since the move, so the dashboards and any alert on them are noise or silent.
Proposed change: derive the probe addresses from the address each service actually listens on (the WireGuard/ops address for the ops ports, 127.0.0.1 where host-bound), or add an explicit inventory variable; note that the same `public_ip` also feeds the WireGuard endpoint variable and the nftables peer sets (night33 finding 2), so decide that variable's meaning first.
Backward compatible? yes (monitoring only).

Tenant/security impact: none; no secret value appears; no patient data. Item 1 may affect the public verification of issued reports.
IRD/regulatory impact: possibly, if report QR verification is part of the report authenticity requirements; to be checked by the owner.
Tests that will prove it:
- item 1: an integration test (real app) for `POST /v1/reporting/verifications` with an invalid token (uniform response, not 500) and with a valid one; on the host, the portal probe `/v/invalid-probe-token` no longer produces `request_failed` lines;
- item 2: after the change `probe_success` is 1 for the ops TCP targets that should be reachable.
