# BL-T20 impl
- Files: features/billing/{server/{types,read.server,write.server,actions},components/*,components/print/*}, app/(staff)/billing/{loading,error,11 pages,exports/[export_id]/content/route.ts}.
- Result: 52/54 pass (static 100%, copy-scan clean). 2 fail = test defects, see BL-T20-dispute.md (combobox role; `entered_in_error` not a spec code).
- [CONV] reason/method coded sets hard-coded from 05-SCHEMA seeds (no B34 wiring); lakh-grouped `NPR x`; refund shown for refund.request OR refund.approve; credit-party filter = id text field.
- Open: credit-party Terms edit / B21 monthly bill / party payment, order receipt wiring of ReceiptPrintView, A4/80mm variant pref, Alt+ shortcuts, help md (BL-T23); CBMS mode, membership id, centres → .orchestra/cr/BL-T20.md.
- Env: ran tests via temp config aliasing store deps (apps/web lacks test devDeps, CR-C7-WEB-T02-a). Typecheck: only fix needed was `print_count`; test-file TS errors are missing deps.
