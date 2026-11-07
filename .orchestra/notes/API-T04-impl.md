# API-T04 impl (writer)
- Files: `repo/agents.repo.ts` (SQL, tenant predicate everywhere, secret_sha256 never selected, credential INSERT without RETURNING), `mappers/agents.mapper.ts` (allowlist DTOs, no nulls), `service/agents.service.ts` (E10-E21), `handlers/agents.handlers.ts` + `handlers/index.ts` (E10-E21 replace stubs).
- [CONV] superseded unused enrolment codes on E14 revoked with reason `other` (seeded g_cs_revoke_reasons), no access row (02-TRD §7.5 lists issue only); E15/E16 one `device_credential.revoke` row per revoked credential.
- [CONV] createAgent asserts at the target centre BEFORE the centre lookup (no 400-vs-403 existence probe); missing backlog_threshold → repo returns coalesce(settings.default_backlog_threshold, 500).
- [CONV] E17 `since` in the future → 400 /params/since; ETag only on Agent responses; E14/E20 `cache-control: no-store`; malformed If-Match → 400 in the handler.
- [CONV] repo cursors are opaque offset cursors (`ponytail:` note; keyset later). Retire stores its reason in revoke_reason_code (no retire column; mirrors FakeRepo).
- Tests: 145/148 pass; 3 failures are test defects → `API-T04-dispute.md`. tsc clean for touched files (pre-existing bsdate TS5097). No eslint in services/api.
- Open: E14 has no row lock — two concurrent issues can leave two active codes (needs `SELECT … FOR UPDATE` on the agent); pinned release channel vs agent channel not checked; agent_config_versions on create/update is API-T06/T08; real SQL never run against Postgres.
