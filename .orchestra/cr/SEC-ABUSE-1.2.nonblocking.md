Title: CR-C1-SEC-ABUSE-1.2: store-wide source for the T28 login-abuse gauges
From chunk: C1            To owner: C2 (identity metrics, T28) / C0-0B if a read function is wanted
Type: port
Blocking? no
Problem: SEC-ABUSE-1 (LD-237 (1), LD-410) moved the login failure windows of identity/handlers/loginStaff.ts from process Maps into the limiter store (HMAC'd keys, Postgres). The gauges lims_identity_login_ip_throttles_active, lims_identity_stuffing_distinct_accounts_15m and lims_identity_stuffing_distinct_ips_15m (02-TRD §13, T28; alert IdentityCredentialStuffing) were computed by scanning those Maps. The store holds only hashed keys with no grant to read across keys, so the gauges can no longer be fed from loginStaff.ts and are no longer set there (they stay registered, value unset).
Proposed change: compute the three gauges from identity.auth_events (login_failed / login_ip_throttled in the last 15 min, distinct email HMAC / client IP), i.e. the auth_events sample already noted as CR-C2-T28-002, e.g. on the worker's metrics tick.
Backward compatible? yes (same metric names, same labels).
Tenant/security impact: none (counts only; no new surface).
Alternatives considered: keep a process-local Map just for the gauges (rejected: SEC-ABUSE-1 test forbids process-local failure state, and per-instance counts under-report with N instances, which is the bug being fixed).
Tests that will prove it: a failing-login burst raises the gauges on a fresh process; IdentityCredentialStuffing rule fixture fires.
