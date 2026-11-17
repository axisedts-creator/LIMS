# WEB-T01 impl
- Files: `features/instruments/nav.manifest.ts`; `app/(staff)/instruments/{loading,error}.tsx` (segment root, covers all 4 routes); `features/instruments/help/instruments.{agents,instruments,messages,settings}.ts`.
- [CONV] nav labels are message keys `instruments.nav.<x>`; no module catalogue merge exists in `core/i18n/messages.ts` (C0-owned), so they render as the key until C0 adds the merge point — open point.
- [CONV] error.tsx copy is English literal (no core error key); shows only `error.digest` as reference, never message/stack.
- [CONV] help copy taken from 04-UI-UX §3/§4 text; helpKey = nav id.
- Tests: `node --test src/features/instruments/__tests__/web-t01.test.ts` → 14/14 pass. tsc: my files clean; pre-existing C0 errors in `app/layout.tsx` (css side-effect imports).
- Open: no page.tsx yet (WEB-T02+); dir without page.tsx should not be a route, so `[...slug]` placeholder should still serve `/instruments/*` — not verified (no `next build` run).
