Title: CR-C17 (number to be assigned by the owner): contracts for the parts of the phlebotomist app UI that have none
From chunk: C17            To owner: C0-0B | C0-0C | C0-0D | C16 (patient app)
Type: schema | api | event
Blocking? yes for the screens listed below; no for the rest of PHLEBO-UI-FULL-1 (built on existing contracts)

Problem (what you cannot do today):
The approved UI pack (PhleboApp_UI_Screens.pdf) draws features for which the spec and `contracts/` have no table, route, event, permission or DTO field. Agents must not invent names, so each shows "Not available yet" or is left out.

| UI page | Need | What is missing |
|---|---|---|
| B01, C01, C01b | "On my way", travel stage "On the way", ETA | a mutation type or route, a visit state or timestamp (visit status has no en-route value) |
| C01b, C01c, G03 | Live location while travelling | write path, storage with retention, read path, consent/privacy review (`visit_locations` holds only arrived/collected/failed points) |
| (patient app) | Patient sees "On the way", live estimate, staff ID | an engagement read route and DTO (`Booking` has no visit id, visit status or collector). The Bookings tab is hidden and `homeCollection:false` today |
| F01, F01b, H01 badge | Alerts | a stored alert feed or an agreed on-device derivation from snapshot changes, plus read state |
| E01, E02 | History | `GET /v1/homecollection/visits` may back this online; offline retention conflicts with the daily cache purge (TRD 7.1). Needs a decision |
| G01 | Weekly collections, on-time rate, rejected samples | a read route and the metric definitions |
| G02 | Staff ID on the ID card | a staff identifier readable by the phlebotomist and shown to the patient |
| D01b, D01c | Receipt confirmation, "tube not found" | a handover read route for the sender (H13-H15 need `handover.receive`) |
| G05c, D01c | Dispatch desk name and phone | a field in `SnapshotConfig` and a tenant setting |
| G05d | Report a problem | a route, storage and who reads it |
| B01, C01e | Age, sex, area, distance, km to go, address-needed chip | fields in `SnapshotVisit` (`birth_on` is sent only when `second_identifier = birth_date`) |
| B01, C04 | Tube cap colour, test names per tube, fasting chip | fields in `SnapshotVisit.specimens` (only codes today); fasting is free text in `note_for_phlebotomist` |
| C01d | Recollection reason from the lab | a reason field in `SnapshotVisit` |

Also found while mapping (existing contracts, not new ones):
1. `contracts/openapi/homecollection.yaml` has no `x-edge-exposure`, and `infra/edge/public-routes.yaml` exposes only `/v1/identity/mobile/sessions*` for C17. A real phone cannot reach register, snapshot, push, ack or sign-off through the public edge. Owner: C0 / C1. See also `.orchestra/cr/DEPLOY-AXIS-013.nonblocking.md`.
2. The pinned issuing-CA certificates (REQ-SEC-104) are not in the repository. The app reads them from the build define `PINNED_CA_PEM_B64` [CONV] and does not start syncing without them. Owner: C1.
3. TRD 2 names `flutter_riverpod` and `lims_api_client`; neither is in `apps/phlebo_app/pubspec.yaml`. This task uses `ChangeNotifier` and the existing pinned `ApiClient`.

Proposed change (exact): to be written by the owners; this CR deliberately proposes no names.
Backward compatible? yes if added as optional fields, new routes and new mutation types.
Tenant/security impact: live location and patient-visible collector identity are new personal data and a new public surface; security checklist (05-DEFINITION-OF-DONE s4) required.
IRD/regulatory impact (billing changes only): none.
Alternatives considered: building with invented names (forbidden); showing sample data as if real (misleading to field staff and patients).
Tests that will prove it: contract tests per new route and mutation, RLS isolation, patient-app visibility tests.
