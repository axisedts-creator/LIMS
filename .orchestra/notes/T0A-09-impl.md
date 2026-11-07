# T0A-09 impl (writer)
- Files: `tools/devstack/{init-secrets,up,down,reset}.ts`, `compose.yaml`, `env/*.env` (no secrets), `envoy/envoy.yaml`, `db-init/99-service-roles.sql`, `package.json` (type module); root `package.json` `dev:up/down/reset`.
- Tests: 10 pass, 1 skip (live), 2 FAIL — both need `tools/devstack/upstream.env.example`; web fetch denied, not invented → CR `.orchestra/cr/T0A-09.md`.
- Live (Docker, synthetic stand-in example, since removed): db/auth/storage/rest/api-gw/pgbouncer/mailpit up; bootstrap ran; lims_api via PgBouncer + lims_migrator login OK; gateway /auth,/storage 200; external-interface probe of 5432/6432/8000/8025 closed; redis `save ""`/`appendonly no`; reset drops volumes.
- Blocked live: migrations (`db/migrations/atlas.sum` missing, 0B) → seeds/seedAuthUsers/registry-sync not exercised. Prism mocks not in compose (no 5.16.0 image; CR item 3).
- [CONV] digests resolved from registry for C1 02-TRD §2 tags (UPSTREAM.lock absent); PGRST_DB_MAX_ROWS=1000; redis = Valkey 9.1.3 (C1 §7.4); hex secrets (URL-safe); up.ts dev glue: CONNECT for SP-3 service roles + SP-5 migrations_meta (CR item 4).
- [CONV] seedAuthUsers / registry-sync are skipped with a notice until their modules exist; their TS steps get libpq PG* env. Envoy has no apikey filter (ponytail note in file).
