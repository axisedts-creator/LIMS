# T0C-SALES-1 impl (LD-321, LD-325)
- Files: contracts/openapi/partners.yaml (15 ops under /v1/partners/admin/sales + 6 schemas + 4 path params), contracts/openapi/homecollection.yaml (flags on listEligiblePhlebotomists items + updateCollectorFlags), db/migrations/20261117210000_partners__add_sales_hierarchy.sql, contracts/permissions.yaml + role-packs.data.yaml corp_admin (partners.sales.read, partners.sales.manage), partners/permissions.ts, partners/index.ts + homecollection/index.ts (pendingOperations), db/meta/tables.yaml + db/policies/partners.sql + homecollection.sql (gate 9); generated: api-client ts/dart, operations.ts, MSW, ports permissions.ts, g_permissions seed, 5 isolation probes + _registry.sql + probe-rows. Over the 12 file cap only by generated / registry files (lead to rule, same as T0C-ACCT-1 / TESTMGMT-1).
- New operations (pendingOperations, T0B-SALES-1 removes them with the handlers): listSalesDesignations, createSalesDesignation, updateSalesDesignation, listSalesRepresentatives, createSalesRepresentative, updateSalesRepresentative, deactivateSalesRepresentative, getSalesTree, assignPartyToRepresentative, unassignPartyFromRepresentative, listRepresentativeClients, listServiceAreas, createServiceArea, updateServiceArea, deactivateServiceArea; homecollection: updateCollectorFlags. partners/index.ts no longer builds a stub for a pending id (a stub would win over the 501 operation_pending handler).
- New permission codes: partners.sales.read (not privileged), partners.sales.manage (privileged, MFA); roles tenant_admin, finance, lab_manager; corp_admin pack 164 / 63.
- [CONV] DB rules: own manager = CHECK; manager loop = BEFORE trigger, WITH RECURSIVE walk up the chain under a per-tenant xact advisory lock (concurrent a-under-b / b-under-a cannot both pass); overlapping assignment of the same party + representative = BEFORE trigger under an advisory lock per party+representative (btree_gist not assumed, so no EXCLUDE), inclusive end, NULL end = open, SQLSTATE 23P01; the service maps both to common.validation_failed (no new error code). Phone / email of a representative are excluded from audit values (tg_row_audit args).
- [CONV] Service areas are free text district + area_text (municipality, ward, landmarks), not pincodes: ElabAssist keys areas by pincode, Nepal addresses use district and municipality. centre_id optional (absent = whole tenant).
- [CONV] Collector decision for the lead (tests note): the repo has no collector table / collector update op, so flags live in the new homecollection.collector_flags (one row per membership, absent row = both true, NOT NULL DEFAULT true) and ONE new op updateCollectorFlags PATCH /v1/homecollection/phlebotomists/{membership_id} (homecollection.settings.manage); no If-Match (two booleans, last write wins).
- Offline classification (founder 09:19): all writes (designations, representatives, assignments, service areas, collector flags) are online only; a representative may read the own client list (listRepresentativeClients) offline from the device cache, refreshed when online. Nothing is queued for bulk push in this task (sync wave LD-319).
- FOUNDER STEPS: push-cloud for db/migrations/20261117210000_partners__add_sales_hierarchy.sql (after 20261117170000); re-apply the role pack (apply-role-pack) so corp_admin gets the two codes. Not done here.
- Runs (writer, 2026-11-17): codegen sales1 + c13 + c17 855/856 (c17 item-shape: dispute); codegen:check and isolation-probe --check fresh; registry-equality "permissions.yaml == IC" 5/5; api 9 files 567/573 (role-packs.data 2 = tester comment bug, homecollection boot 3 = not this change: dispute); api tsc clean; pgTAP T0C-SALES-1 suite via run-suites.sh 0 not ok. New isolation probes generated, not run individually.
- OPEN: (1) c17-openapi.test.ts pins the exact listEligiblePhlebotomists item properties and fails with the two new flags; sales1 requires them: see T0C-SALES-1-dispute.md. (2) No reactivate op for representatives / areas (brief lists deactivate only). (3) Tree depth cap 8 is an API rule (getSalesTree max_depth), not a DB rule. (4) Loop guard assumes READ COMMITTED (default).

## FIELD MAP (sales, designation, sales client list, services in area, collection boy of elabassist-sales-20261117.md; LD-321)
### Sales Representative
- Name — added (sales_representative.name)
- Code — not added — ids identify the row; a human code needs a numbering rule per tenant, CR if the founder wants one
- Mobile No. — added (sales_representative.phone, E.164 on the wire)
- Email — added (sales_representative.email)
- Address — not added — no flow uses a representative's home address; personal data kept to the minimum
- Track — not added — the walk saw no values, the meaning is unclear and tracking a person is a privacy decision for the founder
- Designation — added (sales_representative.designation_id -> sales_designation.name)
- Manager — added (sales_representative.manager_id, self reference, never own manager, no loop)
- Doctor enrol — not added — a send-a-message action (WhatsApp / SMS / e-mail invite), nothing to store; belongs to the messaging desk (T0C-MSGDESK-1)
### Sales Designation
- Level — added (sales_designation.level 1..8, unique per tenant)
### Sales Client List
- Client Code — already present (partner_code / party_code on the party masters; the client row carries party_id)
- Client Name — added (RepresentativeClient.party_name)
- Billing Type — not added — the party kind already says credit or partner; per party commercial settings are T0C-PARTYSET-1
- O/S Balance — added (RepresentativeClient.outstanding_paisa, integer paisa, negative = advance)
- Credit Limit — already present (credit party limits in the existing credit party master); not copied into the client row, one source
- Total Patient — not added — a period volume figure for the sales representative MIS report (T0C-MISREPORTS-1), not a stored field
- Amount — not added — billed amount per period is the same MIS report (T0C-MISREPORTS-1); last_bill_date added to the row
- Rate Master — already present (price lists with party assignments; Rate Master = a named default price list, LD-321)
- EmailId — not added — the party contact e-mail stays on the party master; personal data is not repeated in list rows
- Sales Person — added (party_sales_assignment.representative_id; the client list is per representative)
- Sales Manager — added (sales_representative.manager_id; getSalesTree)
- Sales Ref — added (party_sales_assignment, assignPartyToRepresentative / unassignPartyFromRepresentative; filter = the representative path id)
### Services In Area
- Enter PinCode — not added as a pincode — Nepal addresses use district and municipality; added instead as free text service_area.district + service_area.area_text
### Collection Boy
- Laboratory — already present (the collector is a core.memberships row of the tenant / branch)
- Collection Point — already present (membership centre scope; listEligiblePhlebotomists by centre_id)
- Allow Collection — added (homecollection.collector_flags.allow_collection, default true)
- Allow Pickup — added (homecollection.collector_flags.allow_pickup, default true)
