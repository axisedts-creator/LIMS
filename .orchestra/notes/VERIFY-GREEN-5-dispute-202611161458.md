# VERIFY-GREEN-5 dispute (debugger)
Root cause: web tsc program includes apps/portal pages via test `apps/web/src/features/reporting/__tests__/rs-c6.portal.test.tsx`; there `@/` = apps/web/src, so 7x TS2307 (+2 TS7006).
Every in-ownership fix is closed by a test: (1) relative specifiers in the portal pages break rs-c6.static pins (page/actions.ts hashes, `@/…#sym` import keys); (2) vg5.typecheck.test.ts:41-44 never tolerates TS2307 for modules that exist in portal, so the CR path (brief: list + nonblocking CR) is rejected for exactly these errors.
Only remaining fix is `paths` fallback in apps/web/tsconfig.json: C0-0D owned (spec/program/01-CHUNK-MAP.md:132), app-wide, hides LD-250 missing-module signal; review round 1 rejected it.
Contradiction: brief done_when allows "list in notes + nonblocking CR" (and forbids stub/hiding), vg5 test forbids that path for these 9. Lead picks CR option a/b/c (.orchestra/cr/VERIFY-GREEN-5.md) or relaxes the vg5 filter. I did not edit tests or code.
