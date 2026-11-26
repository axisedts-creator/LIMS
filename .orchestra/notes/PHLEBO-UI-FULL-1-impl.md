# PHLEBO-UI-FULL-1: implementation note (founder choice 2026-11-25: build the contract-covered parts first)

Design source: PhleboApp_UI_Screens.pdf (52 pages). Gaps: see `.orchestra/cr/PHLEBO-UI-FULL-1.md`.

## Built
- Theme and shared pieces (`lib/app/theme.dart`), floating tab bar, step bar on the visit screens.
- Splash, sign in, lock gate, session ended, device states; Today (home, offline, empty, cleared, done), full list,
  visit flow, handover and waiting receipt, outbox, settings, profile, ID card (name only), location, help, FAQs.
- `AppController` (`lib/app/controller.dart`): sign-in and registration (TRD 7.4), re-auth gate, sync loop (TRD 7.2),
  purge, wipe, sign-off. `cache.db` tables from 05-SCHEMA B.1.
- Web: dispatch board, visit detail, handovers and phones refresh every 30 s while visible, paused while a dialog is open (TRD 3.3).
- Android: FlutterFragmentActivity, app data directory channel, biometric / location / camera permissions, tel and geo queries.

## Owner review needed
- New dependency lines in the phlebo pubspec: local_auth, url_launcher, geolocator (same CR-C17-010 pins as lims_ui).
- [CONV] names: secure-storage keys `phlebo.session_token`, `phlebo.access_expires_at`, `phlebo.session_expires_at`,
  `phlebo.display_name`, `phlebo.session_ready`; build defines `PINNED_CA_PEM_B64`, `APP_VERSION`.
- `SyncCycleResult.wipePending` added to the sync engine.
- ChangeNotifier instead of flutter_riverpod (TRD 2); the hand-written pinned ApiClient instead of lims_api_client.
- FAQ answers are written from app behaviour; the wording needs founder approval.
- Logo copied from `packages/ui/assets/brand` into `apps/phlebo_app/assets/brand`.

## Not built (no contract, gap list)
On my way, live location, patient tracking in the patient app, alerts, history, weekly stats, staff ID on the ID card,
handover confirmation / "tube not found", dispatch phone, report a problem, patient age/sex, area/distance,
tube cap colours and test names per tube. Root / integrity check (`core/platform/integrity.dart`) is not part of this task.

## Not wired
`PushResponse.handover_items` is not shown on the handover screen (the engine does not return it).
