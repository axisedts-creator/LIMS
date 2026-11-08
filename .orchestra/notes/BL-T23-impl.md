# BL-T23 impl
- Added 11 help files `apps/web/src/features/billing/help/{invoices,invoice,dues,daily_cash,credit_parties,credit_party,registers,audit_trail,cbms,worklist,settings}.md` (Purpose/Fields/Shortcuts).
- Added manual `docs/manual/billing/{cash-shift,credit-parties,cbms}.md`; edited `exports.md` (intro: not an IRD schema, routes). `tenant-export.md` untouched.
- [CONV] help file name = helpKey suffix; headings `## Purpose|Fields|Shortcuts` (04-UI-UX §11); CBMS stub string verbatim.
- Run: bl-t23 vitest 25/25 pass; copy-scan.mjs clean (54 files). Full suite/lint/typecheck not run (docs-only).
- Open: shortcut keys in help (`?`, `/`, arrow keys, `Page Up/Down`) are not verified against the real KeyboardShortcutsDialog bindings; only `Ctrl+Enter` is from code. HelpPanel loading of these files is BL-T20's. No pending.json change (no handlers).
