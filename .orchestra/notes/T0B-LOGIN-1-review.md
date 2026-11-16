APPROVE

T0B-LOGIN-1 review (reviewer, diff 51864791b..HEAD)
- Fix sits in one place, auth.service.ts session(). Absolute is min(setting, 12) h. Idle is clamped to 15..30, except staff_mobile, which keeps 60..720 from mobileHours. expires_at = absolute.
- SESSION_SQL and APP_SESSION_SQL apply least($n::timestamptz, now() + interval '12 hours') to $16 and $19. now() is the same transaction now() as the created_at default, so the database clock decides (done_when 2, preferred form). The clamp does not apply to patient rows: these statements never insert kind patient.
- Platform path: insertPlatformSession passes created_at = app now (auth-events.repo.ts:149), so there is no skew, and the service clamp also applies. confirmEmailToken uses a fixed SETUP_MINUTES = 15 (idle and absolute 15 min), not a tenant setting, so it is within both checks. verifyMfaChallenge and refresh only read or touch existing rows. Every path in done_when 3 is covered.
- Tests: auth.session-clamp.test.ts evaluates the real INSERT text against the CHECK expressions copied from the migration, with app/db skew from -5 s to +60 s, for every family plus a service-level clamp table. The skew > 0 cases fail on main. The chain test passes. I ran the verify set: 109/109 pass.
- CR .orchestra/cr/T0B-LOGIN-1.nonblocking.md cites 04 A8 / REQ-SEC-073: narrow the settings ranges and do not widen the check (done_when 5).
- No rate-limit, MFA, password, RLS or permission change. No PHI or secrets. Only owned paths touched. Names are verbatim.
- Not a defect: the impl note points to `.orchestra/cr/T0B-LOGIN-1.md`, but the file is `T0B-LOGIN-1.nonblocking.md`. The response body's absolute_expires_at uses the app clock and can be a few ms later than the stored DB-capped value. That is harmless because the server reads the row.
- Not verified: real Postgres. The live sweep is the DB proof.
