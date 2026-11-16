# T0D-WEBFIX-1 tests (tester)
Files: apps/web/src/features/webfix1/__tests__/webfix1.pages.test.tsx + vitest.webfix1.config.ts. Run: .orchestra/notes/T0D-WEBFIX-1-verify.cmd (MSW plays the API with contract shapes and the deployed API's strictness).
Now: 6 fail, 16 pass. Failing for the right reason: (b) partners settings, (c) support-sessions sends `limit`, (d) critical-alerts sends `limit` (page + listCriticalAlertsAction), (e) role-packs and access-review show LoadError instead of "not available yet".
ROOT CAUSES found: (c) listTenantSupportSessions declares only `status`; fix = drop `limit` from admin/support-access/page.tsx. (d) ajv coerceTypes makes `limit` a number and reports-read.handlers.ts:200 accepts only strings, so any `limit` is 400; fix = drop `limit: 50` in reporting read.server.ts listCriticalAlerts (API default is 50). Do not edit the API (CR if wanted).
(b) getPartnerSettings/updatePartnerSettings are stubs in the API (partners/index.ts:53, 500 common.internal): web fix = page shows plain "not available yet" (matches /not available yet/i, no reference, no Save), same as (e). Test mocks 500; writer may instead skip the call.
(e) pages must match /not available yet/i, make no call to /role-packs or /access-reviews; gates and nav permissions unchanged (tests pass already).
(a) NOT reproduced: slots, bookable-items, bookings pass on real shapes (empty, populated, inactive-only centre). Root cause of the engagement error page is unknown; likely needs the Render error digest 324082339 / 4266628093 or a client-side crash with staging data. Writer/debugger: find it, then add a failing test first.

## Round 2 (review item 2, tester)
- t20.audit-sessions AD-15: 5 obsolete tests replaced by one LD-301 test (not available yet, no call, no table/Record button); gate + a11y tests kept. t20 config: 192/192 pass.
- rm-t05.screen: gate tests kept; page test now LD-301 (no call, "not available yet"); diff/apply/axe tests mount RolePackApply directly (coverage kept); 503-read test retired (page no longer reads). rm-t05.contract: gate regex kept, "gate before call" only applies if the page calls. rm-t05 config: 26/26 pass.
- rs-c6 baseline re-recorded via record() in rs-c6.surface.ts: rs-c6 config 60/60 pass.
- NOT DONE: rs-c2.baseline.json re-record (RS_C2_RECORD=1 run was blocked by a permission prompt). Run: RS_C2_RECORD=1 pnpm --dir apps/web exec vitest run -c src/features/admin/__tests__/vitest.rs-c2.config.ts rs-c2.static, then re-run without it. 3 rs-c2.static tests fail until then (data files, route files 24 vs 23, form field names).
- NOT DONE: full apps/web suite run. Item 1 (a) is a writer/debugger item, untouched.
