CHANGES

Reviewer: HC-T20, diff b8537aac..419df7b8. Checks run: HC-T20 vitest config (`--maxWorkers=1 --testTimeout=60000 --hookTimeout=120000 --teardownTimeout=120000`): 5 files, 148/148 pass. `tsc --noEmit -p apps/web`: no errors in impl files. The only errors are in tester-owned test files (msw `onUnhandledRequest`, the same as hc-t18; devices.test:93 exactOptionalPropertyTypes).

1. `apps/web/src/features/homecollection/components/DevicesView.tsx:87`: the wipe-dialog link must use route `staff.admin.user`. In 03-INTERFACE-CATALOG:2317 that route is `/admin/users/{membership_id}`, as 03-APP-FLOW §2.4 says. The link currently goes to the `/admin/users` list. Fix:
   - `types.ts:71` `DeviceRow`: add `membership_id: string`.
   - `read.server.ts:98` `toDevice`: map it as `membership_id: UUID.test(String(d['membership_id'])) ? String(d['membership_id']) : ''`. The field is in DeviceDto, TRD:220.
   - `DevicesView.tsx:87`: use `href={device.membership_id ? `/admin/users/${device.membership_id}` : '/admin/users'}`.
   - Tester: tighten `hc-t20.devices.test.tsx:132` to expect `/admin/users/<membership_id of the device>`.
2. `apps/web/src/features/homecollection/server/write.server.ts:97`: H15 `items` is `1..50` (02-TRD:191), but the re-validation allows 500. Fix: `items.length > 50`.

Non-blocking (no change needed for approval):
- `.orchestra/notes/HC-T17-review.md` came in with commit 1d2b2dd3 (tester). It is outside the HC-T20 tester's role path, so the lead should confirm it is intended.
- `hc-t20.handover.test.tsx` `:159` is body-wide and trivially true. The ruling already noted this as a tester follow-up.
- HC-T20-verify.cmd still runs without the `--maxWorkers=1` and timeout flags (see HC-T20-debug.md). Lead/tester should update it.

Checked OK: verbatim names (H13–H20 routes, permissions `homecollection.handover.receive` / `device.manage` / `settings.manage`, `homecollection.wipe_reasons`, `common.version_conflict`, statuses). Idempotency-Key + If-Match on H15/H17, If-Match on H19. Permission gate runs before any API call, and a 403 renders PermissionDenied. D-125: no visit data on handover screens. Settings ranges match TRD §11.2. GPS, patient SMS and DOB are disabled and never sent as true (D-128/D-129). LD-140: kit components only; status shows tone, icon and word; one primary button. No PHI/barcode logging, no secrets. Impl paths are owned. Tests cover the scan flow (kit BarcodeInput), confirm all-received and confirm with discrepancy, replay and 409. RLS: n/a (web only).
