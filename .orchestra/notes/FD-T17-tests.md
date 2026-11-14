# FD-T17 tests
- Files (apps/web/src/features/frontdesk/__tests__/): `fd-t17.help.test.ts`, `vitest.fd-t17.config.ts`; reuses billing `copy-scan.mjs`.
- Run: `.orchestra\notes\FD-T17-verify.cmd` (root vitest + copy-scan; node-only).
- Covers: help/<key>.md for each frontdesk PageHeader helpKey (registration, order, patient, worklist, discount_approvals) with Purpose/Fields/Shortcuts headings; registration help lists every SHORTCUT_GROUPS key; per-screen content (tabs, A/R keys, MFA, anonymise/retention, cancel); docs/manual/frontdesk covers all 5 routes + key shortcuts; no overclaim; banned-wording scan.
- ASSUMED: help file name = helpKey suffix (`frontdesk.discount_approvals` -> `help/discount_approvals.md`); `help/settings.md` optional (no settings page yet); manual file names free.
- Fail now: `features/frontdesk/help/` and `docs/manual/frontdesk/` missing.
- NOT covered: in-app HelpPanel rendering, Nepali manual, `/frontdesk/settings` screen.
