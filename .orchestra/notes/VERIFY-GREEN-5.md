# VERIFY-GREEN-5 — non-test errors left open (CR: .orchestra/cr/VERIFY-GREEN-5.md)
All 9 come from portal pages pulled into the web tsc program by the test file
`apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx`; `@/` resolves to apps/web/src there.
The modules exist in apps/portal/src (wrong alias in this program, not a missing feature; no stub, LD-250).

- apps/portal/src/app/r/[token]/page.tsx:2 TS2307 '@/features/portal/actions'
- apps/portal/src/app/r/[token]/page.tsx:3 TS2307 '@/features/portal/notices'
- apps/portal/src/app/r/[token]/report/page.tsx:2 TS2307 '@/features/portal/Notice'
- apps/portal/src/app/r/[token]/report/page.tsx:4 TS2307 '@/features/portal/HealthSummary'
- apps/portal/src/app/r/[token]/report/page.tsx:5 TS2307 '@/features/portal/notices'
- apps/portal/src/app/r/[token]/report/page.tsx:6 TS2307 '@/server/api'
- apps/portal/src/app/r/[token]/report/page.tsx:7 TS2307 '@/server/session'
- apps/portal/src/app/r/[token]/report/page.tsx:30 TS7006 'g' (consequence of :6)
- apps/portal/src/app/r/[token]/report/page.tsx:68 TS7006 'n' (consequence of :6)

Runtime question: none (types/resolution only). Decision needed: which config owns the fix (see CR options a/b/c).
