# WEB-CSS-RATCHET-1 impl (LD-241)
Files changed: none by writer. Tester already delivered tests/web/css-class-ratchet.test.mjs, css-class-scan.mjs, css-class-baseline.json; no component/stylesheet touched.
[CONV] No code needed: the real-repo ratchet test is green against today's baseline.
Run: `node --test tests/web/css-class-ratchet.test.mjs` = 13 pass, 0 fail. Violations per app (undefined/used): web 79/218, portal 1/5, partner 5/15, packages/ui 71/245 (156 total).
OPEN: `pnpm -s verify` is RED, unrelated to this task: `@lims/worker#typecheck` fails (TS2835 missing .js extensions in contracts/ports, TS2883, TS2379 exactOptionalPropertyTypes, TS18046 in services/worker + services/api). Other packages' typecheck/build passed or were cached; lint/shared-ts node tests not reached (turbo failed first). Not in this chunk's owned paths; lead to route.
