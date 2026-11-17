APPROVE

Re-review of 22813c3b..HEAD after fixes (ee397bb4, f7dba82c).

Prior findings resolved:
1. MFA rule: help/exports.md:18 and docs/manual/analytics/exports.md:15 now state every export needs MFA (PRD §2 aal2; 07-SECURITY E1).
2. Invented M03 bullet removed from help/dashboard.md; test METRICS.dashboard now ['M04','M12','M27'] (M03 remains only in volume.md, where it belongs).

Checked: only owned paths (help/**, docs/manual/analytics/**) plus tester/notes files; no code, RLS, routes, permissions or error codes; no PHI, no secrets; screenshots synthetic. `an-t24.help.test.ts` 84/84 pass (re-run by reviewer).

Non-blocking (unchanged): screenshots are wireframes, replace with real synthetic-tenant captures later; PageHeader help loader not wired (outside owned paths).
