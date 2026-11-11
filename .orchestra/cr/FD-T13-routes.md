Title: CR-C4-FD-T13-routes: export `./routes` from @lims/shared-ts and make it an apps/web dependency
From chunk: C4            To owner: C0-0A
Type: shared-lib
Blocking? no (FD-T13 builds the labels path locally in apps/web/src/features/frontdesk/components/SuccessPanel.tsx `labelsPath`; swap when this lands)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
C4 04-UI-UX.md:120 (success panel, US-FD-15.1, 08 A13 D-4) says the labels page is reached via `@lims/shared-ts/routes` (route `staff.lab.order_labels`, `/lab/orders/{order_id}/labels`). packages/shared-ts/src/routes/generated.ts holds the route (line 572), but packages/shared-ts/package.json `exports` only has "." and "./spreadsheet", and apps/web/package.json does not depend on @lims/shared-ts, so apps/web cannot import it.
Proposed change (exact):
packages/shared-ts/package.json "exports": add
  "./routes": { "types": "./dist/routes/index.d.ts", "default": "./dist/routes/index.js" }
(with a src/routes/index.ts re-exporting generated.ts plus a path builder that substitutes `{param}` segments), and add "@lims/shared-ts": "workspace:*" to apps/web/package.json dependencies.
Backward compatible? yes — additive export.
Tenant/security impact: none (route templates only; no PHI, no new public surface).
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: local path string in apps/web (current workaround; drifts if the C5 route changes).
Tests that will prove it: FD-T13 label-flow test (fd-t13.states.test.tsx, iframe src matches /lab/orders/{ORDER}/labels) keeps passing after SuccessPanel imports the builder from @lims/shared-ts/routes.
