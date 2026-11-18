APPROVE
T0D-UISCAN-1 review of b43a41dad..HEAD (2 commits, 21 files, all inside lab / anatomic / homecollection / inventory features plus this task's notes; under the 24-file cap; nothing under admin, platform, (auth) or (platform)).

Scope check: display only. No route, permission, server action, contract or API change. lab/server and the app routes are not in the diff. Scan handling (onScan, serial, useScanCapture, auto-accept, reject dialog) is unchanged apart from the extra result-card state. Not applicable here: RLS, idempotency, rate tier, error codes. No CSS added, so tokens.json, kit.css and shell.css are unchanged. No secrets. No logging added. The handover card never shows a foreign scanned value back. Scanned values stay in POST bodies only.

Done_when vs code: receive, collect, dispatch, tracking, handover and count entry each use the kit ScanPanel, or for the lab and PoShared screens its written-out markup ([CONV], so the files keep `<BarcodeInput` for lab-t11.static and t22.source). Receive has one FilterBar with the pills All/Received/Rejected/Errors and their counts. Auto-accept is a switch in the PageHeader actions. The location select stands alone. Every queue table shows its header when empty and has an EmptyState "Scan a label to start". The denied states keep the h1. Edits to the old tests (rs-c5.behaviour, rs-c5.screens line 46) keep the same assertions. The rs-c5 snapshot diff only covers the receive and collect markup of this task (LD-362).

Checks run by the reviewer:
- uiscan1 suite: 32/32 pass.
- rs-c5: 24/27 pass. The 3 reds are pre-existing and not in the diff: the worklist snapshot, rs-c5.static server baseline, rs-c5.static routes.
- lab-t11: 73/74 pass. The red is innerHTML in LabelPage.tsx and LabelRenderer.ts, which this task did not touch.
- hc-t20 148/148, inventory t22 217/217, anatomic t20 191/191.
- tsc: the changed component files typecheck clean. The uiscan1 test files only show the MSW `onUnhandledRequest` typing error that is already in the repo. HandoverDrawer TS2786 appears in the test file only.

Not run by the reviewer: web-style-3, m2.source, r04.*, m4.source, elabmenu1.sidebar, m-series-kit. No CSS was touched, and the writer reports web-style-3 101 and elabmenu 99 green.
Non-blocking notes for a later task: `.lims-scan-result[role=status]` is mounted only after a scan, so some screen readers may miss the first announcement (same pattern as the kit ScanPanel). The Collect EmptyState says "Scan a label to start." with a full stop, while Receive has none. Partners manifest receive and the micro scan screens still use a bare BarcodeInput (listed in the notes).
