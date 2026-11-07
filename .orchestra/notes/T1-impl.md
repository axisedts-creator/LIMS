# T1 impl (writer) — offline green; live re-run BLOCKED (shell approval for docker run denied in this session)
- Files: `gotrue/gateway.ts`, `gateway.http.ts`, `gateway.fake.ts`, `mapping.md`; CR `.orchestra/cr/T1.nonblocking.md` (a patient JWT → lead+founder, b refresh reuse, c admin sign-out, d C1 config).
- Per T1-ruling 6: fake now rotates from the active token when the immediate parent is reused (like v2.197.0); older-token reuse → `reused` + family revoke (stricter, allowed).
- Offline verify.cmd: 75 pass, 1 fail = mapping.test "Live contract run: PASS" line (needs live run); live suite skipped (env-gated). `tsc --noEmit` clean.
- [CONV] adminSignOutUser = magic-link → /verify → /logout?scope=global (no admin session route in v2.197.0); ponytail-marked.
- [CONV] adminFindUserByEmail via `GET /admin/users?filter=` + exact match; 4xx → GoTrueError, 5xx/network/timeout → LimsError common.dependency_unavailable; circuit 5→30 s.
- Open: run `supabase/.temp/t1gt/up.sh` (temp v2.197.0 container :59999, min len 12, TOTP on, autoconfirm off; writes env+service key there), then http.live.test.ts with LIMS_TEST_GOTRUE_URL=http://127.0.0.1:59999, _SERVICE_KEY=$(cat key), _PSQL="docker exec -i supabase_db_LIMS psql -U supabase_admin -d postgres -At -c"; on PASS set mapping.md line 6 to `Live contract run: PASS <date>`; then `docker rm -f lims_t1_gotrue` + delete that dir.
