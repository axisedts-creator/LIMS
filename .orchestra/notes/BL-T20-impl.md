# BL-T20 impl
- Files: features/billing/{server/{types,read.server,write.server,actions},components/*,components/print/*}, app/(staff)/billing/{loading,error,11 pages,exports/[export_id]/content/route.ts}.
- Result: 54/54 pass after tests revised per BL-T20-ruling.md (no impl change needed); copy-scan clean (40 files).
- [CONV] reason/method coded sets hard-coded from 05-SCHEMA seeds (no B34 wiring); lakh-grouped `NPR x`; refund shown for refund.request OR refund.approve; credit-party filter = id text field.
- Open: credit-party Terms edit / B21 monthly bill / party payment, order receipt wiring of ReceiptPrintView, A4/80mm variant pref, Alt+ shortcuts, help md (BL-T23); CBMS mode, membership id, centres → .orchestra/cr/BL-T20.md.
- Env [LD-72]: added 6 test devDeps to apps/web/package.json (versions confirmed via npm view) + pnpm-lock.yaml; lockfile consistent. No temp aliasing config remains. `pnpm install --frozen-lockfile` exits non-zero only on pre-existing ignored build script @scarf/scarf (via prism-cli), unrelated.
- Verified: vitest 54/54 pass (2 files), copy-scan clean. Typecheck: only fix needed was `print_count`.
