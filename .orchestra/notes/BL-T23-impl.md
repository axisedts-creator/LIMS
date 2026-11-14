# BL-T23 impl
- Added 11 help files `apps/web/src/features/billing/help/{invoices,invoice,dues,daily_cash,credit_parties,credit_party,registers,audit_trail,cbms,worklist,settings}.md` (Purpose/Fields/Shortcuts).
- Added manual `docs/manual/billing/{cash-shift,credit-parties,cbms}.md`; edited `exports.md` (intro: not an IRD schema, routes). `tenant-export.md` untouched.
- [CONV] help file name = helpKey suffix; headings `## Purpose|Fields|Shortcuts` (04-UI-UX §11); CBMS stub string verbatim.
- Review fix: removed invented shortcuts (`/`, `Enter` on highlighted row, `Page Up/Down`) from audit_trail, cbms, credit_parties, dues, invoices, registers; worklist `Ctrl+Enter` now Reject/Resolve only.
- Review fix 2: credit_party.md drops invented Terms-tab `Ctrl+Enter`; terms sentence says edits are made elsewhere (Terms tab is read-only).
- Run: bl-t23 vitest 25/25 pass; copy-scan.mjs clean (54 files). Full suite/lint/typecheck not run (docs-only).
- Open: settings/daily_cash/credit_party/invoice shortcut lines (`Ctrl+Enter`, `Tab`, `Esc`, arrows) not in review list, left as-is. HelpPanel loading is BL-T20's. No pending.json change.
