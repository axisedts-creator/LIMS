# T1 impl (writer) — BLOCKED on dispute `.orchestra/notes/T1-dispute.md`
- Files: `gotrue/gateway.ts` (interface + GoTrueError), `gateway.http.ts`, `gateway.fake.ts`, `mapping.md`; CRs `.orchestra/cr/T1.md` (a patient JWT → lead+founder, b refresh reuse, c admin sign-out, d C1 config).
- Offline (fake+unit+mapping): 74 pass, 1 fail (no `Live contract run: PASS` line). Live vs temp v2.197.0 container: 110/113; fails = 2 disputed tests + that line. Typecheck clean; eslint not installed (not run).
- [CONV] adminSignOutUser = magic-link → /verify → /logout?scope=global (no admin session route in v2.197.0); ponytail-marked.
- [CONV] adminFindUserByEmail via `GET /admin/users?filter=` + exact match; sendInvite/Recovery send no `redirect_to` (template builds link).
- [CONV] 4xx → GoTrueError(method,status,error_code); 5xx/network/timeout → LimsError common.dependency_unavailable; circuit 5→30 s.
- Open: patient kind BLOCKED; C1 config min length 6→12 + TOTP on; harness aged all `auth.one_time_tokens` rows in dev DB (synthetic users deleted).
