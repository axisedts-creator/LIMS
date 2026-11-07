APPROVE

Re-review of `git diff 359a3df0..HEAD` (round 2, after a17d8a2f + bf7c2ac0). Ran BL-T13 suites: api 6 files 80/80 pass; worker wiring 10 pass, live 7 skipped (no DB).
Round-1 items:
1. Taxable/other-tax charges: CR `.orchestra/cr/BL-T13.md` (CR-C4-BL13 item A) filed per CR template; fail-closed `catalog.tax_config_missing` kept as interim with `[CR-pending]` comment at credit.service.ts:165; interim test added (nothing stored, charges stay uninvoiced). Resolved as instructed.
2. Line name now `<code> — <patient_display_name>` (credit.service.ts:194), asserted in credit.periodic.test.ts. Fixed.
3. Active-branch check: CR item B filed (IdentityPort.getBranch proposal); `[CR-pending]` comment at credit.service.ts:157; no direct core.branches read. Resolved as instructed.
Re-checked: only C4-owned paths + own .orchestra notes/cr; no PHI/secrets; names unchanged from round 1.

Non-blocking (carried): B23 can return 25 rows when the window straddles Shrawan 1 (openapi maxItems 24); live SQL (FOR UPDATE, unnest update, statement view, worker job under RLS) never executed — needs a DB run before merge; CR-C4-BL13 must be ruled before any tenant with taxable credit charges goes live.
