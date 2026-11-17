APPROVE

Reviewed `git diff c74efab..HEAD` (API-T03) against 02-TRD §7.1, 05-SCHEMA §2.2/§5(a), 03-IC §8, 07-SECURITY AB3/AB4/AB12, PRD AC-01.5–01.7.

- Names are copied exactly from the spec: `app.instruments_resolve_device_credential($1)` (bytea, 32 bytes), its return columns (tenant_id, agent_id, centre_id, credential_id, credential_kind), `auth.device_token_invalid` (401, C7), `lims_instruments_device_auth_failures_total{reason}` with reason format|unknown, prefixes `lmsd_`+43 and `lmse_`+22, `randomToken(32/16)`, `instruments.agent_credentials.last_used_at`.
- Resolver: rejects bad formats before any DB call; runs one SELECT and writes nothing; every failure returns the same `{error}`, so used, expired and unknown credentials all get one identical 401; DB errors propagate. The metric label carries only `reason`, so no credential material and no PHI.
- Kind gate fails closed. The touch is one parameterised UPDATE, throttled in SQL, that changes only `last_used_at`, which is in the mutable-column list. The window is validated.
- Only C7-owned paths are touched. No secrets. No RLS/migration change in scope (the DEFINER function and its policies already exist in 20261105002000).
- Tests: 61/61 pass (verified by running vitest). They cover done_when (formats, kinds, touch throttle, failures metric) and AC-01.5/01.6/01.7 through the core registry.

Non-blocking notes (no change required for this task):
1. The metric goes to a no-op sink until CR-C7-API-T03 (core metrics DEFS) lands, so the alert `InstrumentsDeviceAuthFailureSpike` stays dark until then. The CR is filed correctly.
2. There is no TS integration test against a real DB. DEFINER behaviour (used/expired/revoked returns no row, role grants) is covered by db/tests/instruments/T0B-10.C7_behaviour.test.sql. No module in the repo has a TS DB integration harness yet.
3. Nothing calls `touchCredential` or `requireCredentialKind` yet. Handler wiring belongs to API-T04/T06, and their reviews must check that both are called on the request tx.
