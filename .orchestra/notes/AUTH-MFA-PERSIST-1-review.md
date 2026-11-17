APPROVE
# AUTH-MFA-PERSIST-1 review (reviewer) - LD-248, LD-189
Diff 4abcb6288..5b78ce4c6: 9 files (brief cap 10), all in brief paths + role notes. No API, SQL, migration, policy, grant or GoTrue gateway change (LD-248 RULES held).

Checked:
- done_when API: mfa.persist.test.ts walks loginStaff -> start -> complete -> resolve active -> SECOND login mfa_pending -> verify active -> third login mfa_pending, for platform-only (tenant_id NULL), tenant mfa_required and platform+tenant (tenant path). Real auth.service / handlers / mfa.repo; fake login context mirrors the SQL; the SQL bodies (identity_login_context IS NOT DISTINCT FROM, policy mfa_factors__select__owner_only, identity_platform_auth_read_mfa_factors IS NULL, write DEFINER IS NULL, FACTOR_VERIFY_SQL `=` only with non-null tenant) pinned statically. Rollback characterisation test proves the live cause.
- Notes: per-query NULL matching table present; plain statement that no code change repairs a DB without migration 20261115157000 + deploy; founder steps listed.
- Web 409: start 409 (`common.version_conflict`, existing code) -> refreshSessionStateAction (existing route session/resolve via sessionCall, touch:false; returns only {ok,state}/{ok,code}, token never leaves server, test asserts) -> mfa_pending -> /auth/mfa, active -> /, else one role=status line + Sign in link. Other failures keep the alert. Reading "shows the code step" as /auth/mfa (verify needs mfa_pending) is sound.
- No PHI/secrets/logging added; names verbatim; nothing invented. Tenant isolation untouched (no SQL change).

Ran:
- api `vitest run src/modules/identity`: 5509 pass, 2 fail, 72 skipped. Both failures outside this diff and pre-existing: role-packs/route-guard.test.ts (AppShell.tsx nav filter regex) and security/static.security.test.ts (flags platform-ddl-1.static.test.ts). Not caused by this task.
- web t12 config: 6 files, 142 pass.
- web tsc: in auth paths only the existing msw `onUnhandledRequest` typing error class (t12.actions.test.ts already has it; new t12.mfa-409.actions.test.ts copies it). No error in non-test code.

Not verified: full `pnpm -s verify` (writer also did not run it); SQL against Postgres; live GoTrue/staging.
