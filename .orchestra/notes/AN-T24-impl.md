# AN-T24 impl (Help + manual)
- Added `apps/web/src/features/analytics/help/*.md` (17 screens: dashboard, 12 report slugs, referral-incentive, exports, schedules, report_run) — each has Purpose, Metrics/Fields, period/freshness/centre-scope sections.
- Added `docs/manual/analytics/{README,dashboard,reports,referral-incentive,exports,schedules}.md` + 8 PNGs in `images/`.
- [CONV] Help file name = last segment of helpKey (per tester assumption). Copy taken from 04-UI-UX §13 / PRD §8.2; no payout wording.
- Screenshots are Pillow-drawn wireframes of the synthetic "Demo Lab", captioned synthetic; not captures of the live UI (generator script not committed).
- Review fixes: every export needs MFA (help + manual exports.md, PRD §2 / 07-SECURITY E1); removed invented M03 bullet from dashboard help.
- Tests: `an-t24.help.test.ts` 84/84 pass. Not run: full suite, tsc, linter (docs-only change; nothing wires help files into the UI yet).
- Open: PageHeader does not yet load `help/*.md` (no loader in owned paths); replace wireframes with real captures once a seeded demo tenant exists.
