# T0B-REVIEW-1 tests (tester)
- File: `tests/db/T0B-REVIEW-1.reports.test.mjs` (static node test, no database; the lane cannot run SQL).
- Run: `node --test tests/db/T0B-REVIEW-1.reports.test.mjs` (verify: `.orchestra/notes/T0B-REVIEW-1-verify.cmd`).
- Proves: exactly 3 `.orchestra/cr/T0B-REVIEW-1.<n>.nonblocking.md`; each has Intent / Current behaviour / Callers / Proposal / Tests with bodies; they cover provider_events, engagement policies, mfa_factors (one each, key names present).
- Also: Intent cites spec ids + LD-232; Callers file:line exist in tree; Proposal has exact REVOKE/ALTER|DROP|CREATE POLICY text, no GRANT, new policies AS RESTRICTIVE (narrow only); Tests section concrete.
- Git scope: working tree + `[role] T0B-REVIEW-1` commits touch only the 3 CRs, the test and `.orchestra/notes/T0B-REVIEW-1-*`; nothing under db/ spec/ services/ apps/ packages/.
- State now: 7 of 8 fail (no CRs yet; each CR check requires all 3 files, none pass vacuously); the git-scope check passes. Static only, nothing run against a database.
