# HC-T20 impl (writer)
Files: components/{HandoversView,HandoverDrawer,DevicesView,SettingsForm}.tsx; app/(staff)/homecollection/{handovers,devices,settings}/{page,loading,error}.tsx; help/{handovers,devices,settings}.md; server/{read.server,write.server,actions}.ts, query.ts, labels.ts, types.ts extended (H13/H14/H16/H18/H20 reads, H15/H17/H19 writes).
[CONV] LD-140: kit components only, status = tone + icon + word, one primary button per page; Drawer has no footer prop so Confirm sits in the content.
[CONV] Single-flight: a `done`/`saved` ref after success (drawer, wipe dialog, settings until next edit) stops a repeated click or Ctrl+Enter sending a second request.
[CONV] Disabled switches (capture_gps, notify_patient_on_assign) are always sent false; stored `birth_date` is kept as is, DOB radio disabled. Allow-lists rebuilt in read.server.ts; settings response missing a key is a 500.
[CONV] H17 409 common.version_conflict (post-ruling): wipe dialog closes, danger toast DEVICE_CHANGED, router.refresh; row status not flipped.
Review fixes: DeviceRow.membership_id (UUID-checked), wipe link = staff.admin.user `/admin/users/{membership_id}`; H15 items 1..50. [CONV] HandoverDrawer hides itself after a confirm (the modal was aria-hiding the toast).
Round 2: removed stray tests/homecollection/tmpfix.sh (out of scope). Tests (full HC-T20 config via HC-T20-verify.cmd flags, --maxWorkers=1): 148 of 148 pass. tsc: no errors in impl files; test files have TS errors (msw `onUnhandledRequest`, exactOptionalPropertyTypes at devices.test:93) — tester-owned. ESLint: no config matches these paths, not run.
Round 3 (LD-171): no impl change; verify flags re-run 2026-11-14: 5/5 files, 148/148 pass.
Open: hc-t18.nav duplicate chord "g t" (anatomic.tracking vs homecollection.handovers) still needs a lead call.
