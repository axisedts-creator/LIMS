# C6-T25 impl (writer)
Files: handlers/messaging-admin.handlers.ts, service/messaging-admin.service.ts, repository/messaging-admin.repo.ts, index.ts (wires `messagingAdminHandlers`).
Result: 145/145 pass (handlers+static+fakedb+manifest) after harness fix per ruling; no impl change needed. tsc: no messaging-admin errors.
[CONV] M2/C3 read the version first (stale never issues an UPDATE) and the guarded UPDATE still settles races; M2 create = INSERT .. ON CONFLICT DO NOTHING (no row -> version_conflict).
[CONV] C2 = INSERT .. ON CONFLICT (tenant_id, channel) DO UPDATE; never sets callback_token_sha256. secret_ref also rejects `..`. recording rejected when env LIMS_CORE_ENV=production.
[CONV] C3 callback_url = `$LIMS_ORIGIN_API` + /v1/reporting/provider-callbacks/<issueToken('callback')>; relative URL if unset outside production, common.internal in production; `cache-control: no-store`; only sha256 bound.
Open: M1 max_length default per kind (KIND_MAX_LENGTH) is my assumption; seed rows (db/seeds/004) unchanged. Pre-existing unrelated failures: repository.static (portal.service inline SQL), bulk-release.load timing.
