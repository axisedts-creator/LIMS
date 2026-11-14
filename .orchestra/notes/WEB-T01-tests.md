# WEB-T01 tests
- File: `apps/web/src/features/instruments/__tests__/web-t01.test.ts` (node:test; node strips TS natively, same as `build:nav`; no vitest/web config exists).
- Run: `.orchestra\notes\WEB-T01-verify.cmd` (= `cd apps\web && node --test src/features/instruments/__tests__/web-t01.test.ts`).
- Covers: manifest = four 04-UI-UX §1 entries verbatim (id/routeId/permission/group/order/chord, module=`instruments`); each routeId is a non-parameterised staff_web route with the same permission; `node src/core/nav/build-nav.ts` exits 0 and emits all four ids+paths into `generated.ts` (done_when); build-nav rejects a drifted permission.
- Route segment `app/(staff)/instruments`: `loading.tsx` + `error.tsx` with default export for agents/instruments/messages/settings (own dir or segment root); `error.tsx` starts with `'use client'` and never uses `error.message`/`error.stack` (no leak).
- Help: `features/instruments/help/<id>.ts` for the 4 nav ids = HelpPanel shape (C0 §7), plain data (no `@/` imports), link routeIds exist; any `helpKey` literal under the segment must have a help file.
- Verified now: all fail — `missing …\features\instruments\nav.manifest.ts`, `app/(staff)/instruments exists`, `missing …\help\instruments.*.ts`.
- Assumptions: helpKey = nav id (only `instruments.agents` is explicit in the spec); help export is default or sole named export; page.tsx not required here (screens are WEB-T02+).
- Not covered: rendering/axe (no component harness yet), `next build`, nav label message-key catalogue.
