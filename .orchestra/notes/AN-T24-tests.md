# AN-T24 tests (Help + manual)
- `apps/web/src/features/analytics/__tests__/an-t24.help.test.ts` + `vitest.an-t24.config.ts` (file-system checks, node env, no UI).
- Run: `.orchestra\notes\AN-T24-verify.cmd` (from repo root: `node node_modules\vitest\vitest.mjs run --config apps/web/src/features/analytics/__tests__/vitest.an-t24.config.ts`).
- Screens discovered from source: helpKeys in components + report slugs in `server/reports.server.ts` (17 screens: dashboard, 12 report slugs + referral-incentive, exports, schedules, report_run).
- ASSUMED naming (dispute if wrong): `help/<last segment of helpKey>.md` (e.g. `income.md`, `referral-incentive.md`, `report_run.md`); each has title + Purpose + Fields/Metrics headings.
- Help content: M-ids per screen (PRD §8.2), Nepal-time business day, A.D./B.S., freshness, centre scope, plus spec copy (patient-days, cash basis, age anchor, link-only, not statutory, referral recorded).
- Manual: `docs/manual/analytics/{README,dashboard,reports,referral-incentive,exports,schedules}.md`, every route + report path mentioned, >=6 PNG screenshots in `docs/manual/analytics/images/` (valid PNG, local links, alt text, "synthetic" caption, no orphans).
- Copy: no payout word (line-level, file names too), no real emails/secrets. Currently fails: help/ and docs/manual/analytics/ do not exist.
