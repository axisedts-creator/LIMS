Title: CR-C0-0D-SALES-1: contract gaps found building the T0D-SALES-1 sales screens and collector settings dialog
From chunk: C0 (lane C0-0D, task T0D-SALES-1)            To owner: C0-0B (contracts/openapi/partners.yaml, homecollection.yaml)
Type: api
Blocking? no. T0D-SALES-1 ships with the limits below. Item (a) is a real user-facing defect: once a flag is saved false, the screen cannot turn it back on.

Problem (what cannot be done today):
(a) Collector flags have no read. updateCollectorFlags (PATCH /v1/homecollection/phlebotomists/{membership_id}, homecollection.settings.manage) has no matching read. listEligiblePhlebotomists needs centre_id and homecollection.visit.assign. The device list rows (DeviceRow) carry no centre and no flags. So the "Collector settings" dialog (apps/web/src/features/homecollection/components/DevicesView.tsx) always opens with both boxes ticked (LD-321 default). It only sends changes to false. A collector saved with allow_collection=false shows ticked, and `{allow_collection: true}` can never be sent. Story: done_when item 3 (Allow Collection and Allow Pickup on the collector form).
(b) RepresentativeClient (partners.yaml components.schemas.RepresentativeClient) has no `version`. unassignPartyFromRepresentative requires If-Match. The web sends "1" (apps/web/src/features/partners/server/salesActions.ts unassignPartyAction). A second unassign after a future-dated first unassign (row now version 2) always answers 409.
(c) No tenant-wide client list. The partners/sales/clients screen calls listRepresentativeClients once per representative (one page of 200 representatives). That is N+1 requests and misses representatives past the first page.
(d) No Activate for service areas. deactivateServiceArea exists, but no operation reverses it, so a deactivated area can only be re-created.

Proposed change (exact, all additive):
(a) Add optional `allow_collection: boolean` and `allow_pickup: boolean` to the device list row schema in homecollection.yaml. Or add `GET /v1/homecollection/phlebotomists/{membership_id}` (operationId getCollectorFlags, x-permission homecollection.settings.manage) returning `{ membership_id, allow_collection, allow_pickup }`.
(b) Add required `version: integer (minimum 1)` to RepresentativeClient. The handler returns the assignment row version.
(c) Add `GET /v1/partners/admin/sales/clients` (operationId listSalesClients, x-permission partners.sales.read, paged with cursor, filters representative_id?, party_kind?). Rows are RepresentativeClient plus `representative_id` and `representative_name`.
(d) Add `POST /v1/partners/admin/sales/areas/{area_id}/activate` (operationId activateServiceArea, x-permission partners.sales.manage, If-Match, x-idempotency none). It mirrors deactivateServiceArea.
Backward compatible? yes. Every item adds a new optional field or a new operation. For (b), the field is new in a response, so existing clients ignore it.
Tenant/security impact: no new PHI. Same RLS as the existing partners and homecollection tables. Each new read uses the existing permission of its area. No new public surface.
IRD/regulatory impact: none (outstanding_paisa already exposed).
Alternatives considered: (a) read the flags through listEligiblePhlebotomists. Rejected: it needs centre_id and a different permission (visit.assign). (b) Re-read the row before unassigning. Rejected: the row carries no version to read. (c) Keep the fan-out. Accepted for now, with this ceiling.
Not a contract gap (web follow-up, noted for the record): getSalesTree already pages (common.invalid_cursor, next_cursor). The web reads one page of 200 nodes (apps/web/src/features/partners/server/sales.server.ts getSalesTree) and should follow next_cursor.
Tests that will prove it: (a) sales1.collector.test.tsx: the dialog starts from stored values and can send `{allow_collection: true}`. (b) sales1.clients.test.tsx: unassign sends If-Match equal to the row version. (c) clients screen makes one list call. (d) areas screen offers Activate on an inactive row. Each test is paired with a T0C/T0B contract and handler test.
