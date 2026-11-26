# PHLEBO-UI-FULL-1: implementation note

Branch `feat/phlebo-tracking-bridge` (worktree `C:\LIMS-phlebo`), cut from `feat/mhn-v1.1-approved-slices`.
Design source: PhleboApp_UI_Screens.pdf. Founder decisions 2026-11-25 and 2026-11-26 are noted per item.

## Built
1. **Phlebotomist app UI**: theme, tab shell, sign-in, lock, device states, Today, visit flow, handover receipt, outbox,
   profile, help; `AppController` (sign-in, sync loop, purge, wipe, sign-off); preview entry `lib/main_preview.dart`;
   app icon and native splash copied from the patient app's Android resources.
2. **Phlebotomist applications** (founder request): apply form in the app (name, Nepal mobile, email, area, full/part time,
   single/double shift and times of day, licence, training certificates, ID, photo); staff page
   **Home collection > Phlebo applications**; the web bell lists waiting applications.
3. **Approval**: the web approve step sends the existing staff invite (identity `inviteUser`) with the chosen role and
   centre, then records the decision. The applicant sets a password from the invite email.
4. **Phone sign-in**: `openMobileSession` accepts `phone_e164` instead of `email`.
5. **Live tracking bridge**: phlebo app "On my way" + position every 15 s while the app is open; server keeps only the
   latest position; the patient booking's existing `tracking` block is fed from it; patient booking screen shows a map.
6. **Web**: home-collection screens refresh every 30 s (TRD 3.3).

## Names introduced (need owner review; the spec had none)
- Tables: `homecollection.visit_tracking`, `homecollection.phlebo_applications`, `homecollection.phlebo_application_documents`.
- Functions: `app.homecollection_application_create`, `_upload_state`, `_add_document`, `_submit`; `app.identity_staff_email_for_phone`.
- Operations (homecollection.yaml): `updateVisitTracking`, `createPhleboApplication`, `uploadPhleboApplicationDocumentChunk`,
  `submitPhleboApplication`, `listPhleboApplications`, `getPhleboApplication`, `decidePhleboApplication`,
  `downloadPhleboApplicationDocument`. `MobileSessionOpenRequest` gained `phone_e164` (email no longer required alone).
- Permissions: `homecollection.application.manage` (tenant_admin, lab_manager), `homecollection.application.submit`
  (added to `patient_pre_auth`). Errors: none new (existing `common.immutable_record`, `common.validation_failed` reused; IC §8 gate forbids new codes without a lead decision).
- Admin notice kind `phlebo_application_received` / subject `phlebo_application`. Route `staff.homecollection.applications`.
- Env: `LIMS_HOMECOLLECTION_APPLICATION_DIR` (document folder on the API host), app defines `TENANT_CODE`, `PINNED_CA_PEM_B64`, `APP_VERSION`.
- Phlebo app dependencies: `local_auth`, `url_launcher`, `geolocator` (already pinned for lims_ui), `file_picker 12.3.0`,
  `flutter_image_compress 2.5.1` (new: need rows in T0-03-dependencies.md).

## Deliberate shortcuts (each has a `ponytail:` or comment in code)
- Applicants reuse the `patientPreAuth` scheme (tenant code only) instead of a new pre-auth scheme.
- Documents: sent as base64 pieces of at most 512 KB over JSON (the API has no multipart parser and a 1 MB body limit),
  stored gzip-compressed on the API host's disk, 2 MB each. No virus scan; one API host. Move to core uploads/storage (SP-1).
- Bell: lists waiting applications only. Admin notices are written to `identity.admin_notices` but the bell does not read that table yet.
- Decisions overridden by the founder: D-MAPS (a map is shown in the patient app; OpenStreetMap tiles as in the address picker),
  staff self-application, staff phone sign-in (C1 `EXTERNAL_PHONE_ENABLED=false` is unchanged: GoTrue still signs in by email).
- Patient `bookings` source rule ("no map") is kept by putting the map widget in `features/mhn/live_collector_map.dart`.
- Tests changed on purpose: `hc-t18.nav.test.ts` (new menu entry), `bookings_and_reports_integration_test.dart`
  (placeholder text "Provider integration pending (BLOCKED)" replaced), `db_ci_guards_test.dart` (CRLF fix from f6bb668de).

## Not done / not verified
- No run against a live API: the flows were tested per layer (database scenarios on the dev stack, service unit tests,
  app tests against fakes). Edge exposure of the homecollection routes is still missing (`infra/edge/public-routes.yaml`).
- Invite email delivery, TextBee SMS and patient sign-in on a deployed server were not exercised.
- Migrations are not applied anywhere (they were applied and rolled back on the dev database for the scenarios).
- Not regenerated / not run: `db/policies/homecollection.sql` dump, isolation probe registry and per-table isolation tests,
  `tests/security/authz-classification.json`, probe manifest, `docs/manual` pages, role packs (no role holds the new
  manage permission until the role pack or roles are updated).
- ETA and distance are not computed. Position sharing stops when the phlebo app is in the background.
- Still without contract: alerts, history, weekly stats, staff ID on the ID card, handover confirmation shown to the
  sender, dispatch phone, report a problem (see `.orchestra/cr/PHLEBO-UI-FULL-1.md`).
- iOS: nothing was built or run.
