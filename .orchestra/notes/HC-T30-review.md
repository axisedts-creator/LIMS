CHANGES
# HC-T30 re-review (diff 5ea3e984c..f72f6e62b)

I re-checked items 1-7 from the first review. Items 1-6 are fixed. Visit and handover statuses now match 05-SCHEMA. Specimens come from A2. The test pushes `payment.captured`, identity and consent, and checks per-mutation `results` and `handover_items`. The Dart test now covers 401 -> refresh -> same key and the same body.

Item 7: handled as asked. CR `.orchestra/cr/HC-T30.md` was filed to C0-0A, and the impl notes say done_when is NOT met. The task stays open until the nightly run is green.

One defect is left. It would make the scenario fail on the compose stack:

1. `apps/web/src/features/homecollection/tests/e2e/HC-T30.nightly.spec.ts:76`: the A2 snapshot GET sends no `x-lims-app-version` header. 02-TRD §5 preamble says every A* endpoint reads `X-Lims-App-Version`. `services/api/src/modules/homecollection/snapshot.service.ts:67-68` throws `400 common.validation_failed` (`/x-lims-app-version`) when the header is missing, so step 4 fails, and steps 5-11 fail after it. Fix: use `H(DEVICE_TOKEN, { 'x-lims-device-id': DEVICE_ID, 'x-lims-app-version': '1.0.0' })`, the same headers as `push`.
