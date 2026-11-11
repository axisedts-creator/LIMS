# BL-T23 tests
- Files (apps/web/src/features/billing/__tests__/): `bl-t23.help.test.ts`, `vitest.bl-t23.config.ts`; reuses `copy-scan.mjs` (BL-T20).
- Run: `.orchestra\notes\BL-T23-verify.cmd` (root vitest + copy-scan; node-only, no jsdom).
- Covers: help/<key>.md for every PageHeader helpKey (invoices, invoice, dues, daily_cash, credit_parties, credit_party, registers, audit_trail, cbms, worklist, settings) with Purpose/Fields/Shortcuts headings; neutral IRD wording (immutable invoice, cancel+reason+credit note, CBMS stub string, exports "not an IRD schema", no overclaim); manual pages exports/cash-shift/credit-parties/cbms/tenant-export + every billing route mentioned; banned-wording scan.
- ASSUMED: help file name = helpKey suffix (`billing.daily_cash` -> `help/daily_cash.md`); heading names above. Dispute if wrong.
- Fail now: `apps/web/src/features/billing/help/` missing; manual `cash-shift.md`, `credit-parties.md`, `cbms.md` missing (`exports.md`, `tenant-export.md` already exist; their assertions may pass/fail on content).
- NOT covered: in-app rendering of HelpPanel from these files (BL-T20 owns), Nepali manual, frontdesk help (FD lane).
