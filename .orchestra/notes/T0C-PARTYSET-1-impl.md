# T0C-PARTYSET-1 impl (LD-321, LD-325)
- Files: contracts/openapi/partners.yaml (13 ops under /v1/partners/admin + 5 schemas + 6 params; tax_number / national_id_number on createPartner, updatePartner, PartnerAdmin), contracts/openapi/catalog.yaml (5 ICD master ops under /v1/catalog/icd-master + IcdMasterCode; doctor fields; credit party pan masked), db/migrations/20261117220000_partners__add_party_settings_and_penalties.sql, contracts/permissions.yaml + role-packs.data.yaml corp_admin, partners/permissions.ts + catalog/permissions.ts, partners/index.ts + catalog/index.ts (pendingOperations), db/meta/tables.yaml, db/policies/partners.sql + catalog.sql, g_permissions seed; generated: api clients ts/dart, operations.ts, MSW, ports permissions.ts, 5 isolation probes + _registry.sql + probe-rows. Over the 14 file cap only by generated / registry files (lead to rule, as T0C-SALES-1). codegen also refreshed packages/shared-{ts,dart} routes (staff.engagement.content was stale on the lane before this task).
- New operations (pendingOperations, T0B-PARTYSET-1 removes them with the handlers): partners: getPartyCommercialSetting, setPartyCommercialSetting, listPartyOnboarding, decidePartyOnboarding, listNonCompliancePenalties, createNonCompliancePenalty, updateNonCompliancePenalty, deactivateNonCompliancePenalty, listNonComplianceEvents, raiseNonComplianceEvent, waiveNonComplianceEvent, chargeNonComplianceEvent, revealPartyIdNumber; catalog: listIcdMasterCodes, searchIcdMasterCodes, createIcdMasterCode, updateIcdMasterCode, deactivateIcdMasterCode.
- New permission codes: partners.party_setting.read (tenant_admin, finance, lab_manager), partners.party_setting.manage (tenant_admin, finance), partners.onboarding.decide (tenant_admin, lab_manager), partners.party_id_number.read (privileged, MFA; tenant_admin, finance), partners.penalty.manage (tenant_admin, finance, lab_manager), catalog.icd.manage (tenant_admin, lab_manager); corp_admin pack 182 / 68.
- [CONV] DB rules: onboarding moves pending -> approved | held | rejected, held -> approved | rejected (BEFORE UPDATE trigger, SQLSTATE 23514); hold / reject need a reason and pending <=> no decided_at / decided_by (CHECK). Event moves raised -> waived | charged only; charged <=> ledger_entry_id; UNIQUE (tenant_id, ledger_entry_id) = one ledger entry, charged once; a decided event keeps ledger entry, amount and party for good. Settings: one row per party (UNIQUE tenant, party_kind, party_id); an unsaved party reads the defaults (is_default true), the first PUT needs no If-Match. Penalty ids composite tenant FK; party_id polymorphic (service checked, as T0C-SALES-1).
- [CONV] Government ID numbers: tax_number (PAN; on a credit party the existing `pan`, never renamed) and national_id_number are masked in every read (last four characters only); the full value only through revealPartyIdNumber with partners.party_id_number.read, every reveal writes an audit event (never the value). The values never reach audit.audit_log (partners__audit, doctors__audit, credit_parties__audit re-created with the ID columns excluded), never appear in logs, and exports carry them masked unless the caller holds partners.party_id_number.read. RETENTION: founder confirms the retention rule for PAN, Aadhar style and national id numbers (founder step; until then kept for the life of the party record, deletion is a founder decision).
- Repo contradictions for the lead: (1) an ICD pick list already exists (frontdesk.icd_codes, listIcdCodes / createIcdCode / updateIcdCode, registration); the brief's master is the new per tenant catalog.icd_code with 5 *IcdMasterCode ops; the frontdesk list stays untouched (a later task may seed or replace it from the master). (2) brief "active" = repo is_active. (3) brief "tax_number on parties": partners gain tax_number + national_id_number, credit parties keep pan (masked in reads, full value in requests).
- Offline classification (founder 09:19): settings reads may be cached on the device (getPartyCommercialSetting), refreshed when online; onboarding decisions, penalty raise / waive / penalty charge and ID reveals are online only, never queued for bulk push, the reveal value is never cached. The lab number scheme is a plain code here; its offline number blocks belong to the offline wave (LD-319 / T0C-SYNC-1). Interest per day is a statement line only, never posted (LD-321).
- FOUNDER STEPS: push-cloud for db/migrations/20261117220000_partners__add_party_settings_and_penalties.sql (after 20261117210000); re-apply the role pack (apply-role-pack) so corp_admin gets the six codes; confirm the ID number retention rule. Not done here.
- Runs (writer, lane C0-0M, after ruling TESTS_WRONG + tester revision f47ed3d82, no impl change): full verify.cmd green: partyset1-openapi 145/145; c13, catalog, testmgmt1, pricetools1, testimport1 1347/1347; registry-equality permissions 5 passed; services/api 14 files 665 passed, 1 skipped; pgTAP T0C-PARTYSET-1 0 not ok. Ruling item 4 (C13 / C3 schema count re-pins) is tester work, outside verify.cmd.
- REWORK LD-385 (writer, 2026-11-18): commission_bp removed from Doctor, DoctorCreate, DoctorUpdate, DoctorCreated, their examples and the DoctorUpdate.unset enum (maxItems 10 -> 9) in catalog.yaml; migration edited in place (column, doctors__commission_bp__ck, header and DOWN lines); tables.yaml catalog.doctors column dropped; codegen re-run (catalog.ts, operations.ts, MSW). No other doctor rate in contracts, db, tools, apps, services, packages. Runs: referrers.wording + partners/catalog pending, boot, skeleton, role-packs 111 passed; codegen 1488 passed, 4 FAIL; pgTAP 0 non-rate failures except 409/414 (cascade from the rejected doctor insert 170). All failures pin catalog.doctors / Doctor commission_bp = tester revision named by LD-385 (partyset1-openapi.test.ts :452-484, :639-642 and the db test), not yet applied on this lane.
- OPEN: (0) tester LD-385 revision of partyset1-openapi.test.ts and the db test + probe rows. (1) ruling item 4 re-pins (tester). (2) Center Test Mapping not added (see FIELD MAP). (3) onboarding rows are created by the service (T0B-PARTYSET-1) when a party is created for approval; no create op in the brief.

## FIELD MAP (Affiliation master, per client settings, franchise approval, doctor master, ICD, Outsource, Interlab, Center Test Mapping, Non Compliance; labels as named by the brief, LD-321)
### Affiliation master
- Commission — added (party_commercial_setting.commission_bp, integer basis points 0..10000)
- PAN — added (partners.tax_number; credit parties already present as pan), masked in reads
- Aadhar — added as national_id_number (partners.partners, catalog.doctors), masked in reads; Nepal has no Aadhar, the national id number is the equivalent
- Printing block — added (party_commercial_setting.print_exception: the party's reports print outside the normal print block rules)
- Header — added (party_commercial_setting.header_footer_mode)
### Franchise approval queue
- Approve — added (decidePartyOnboarding decision approve; party_onboarding.status approved)
- Hold — added (decision hold with a reason; status held, later approve or reject)
### Per client settings
- Auto release — added (party_commercial_setting.auto_release_reports)
- WhatsApp — added (party_commercial_setting.whatsapp_enabled)
- Insurance — added (party_commercial_setting.insurance_enabled)
- Print exception — added (party_commercial_setting.print_exception)
- Lab number scheme — added (party_commercial_setting.lab_number_scheme_code, plain code; number blocks in the offline wave)
- Billing cycle — added (party_commercial_setting.billing_cycle daily, weekly, fortnightly, monthly, quarterly)
- Invoice payment — added (party_commercial_setting.invoice_payment_days 0..365)
- Blocking — added (party_commercial_setting.invoice_blocking_days 0..365 + auto_block_overdue; credit account block flags already present in billing)
- Warning — added (party_commercial_setting.invoice_warning_days 0..365)
- Interest per day — added (party_commercial_setting.interest_bp_per_day 0..10000, statement line only)
- Priority — added (party_commercial_setting.priority P1..P5)
- Header and footer — added (party_commercial_setting.header_footer_mode with, without, both)
- TDS — added (party_commercial_setting.tds_bp, default 0)
### Doctor master
- National ID number — added (catalog.doctors.national_id_number, masked in reads)
- Speciality — added (catalog.doctors.speciality)
- Qualification — already present (Doctor.qualification)
- Hospital — added (catalog.doctors.hospital)
- Registration number — already present (Doctor.registration_no + registration_council)
- Doctor rate — not added on the doctor record (LD-385): (C3 AC-11.5); lives only in party_commercial_setting.commission_bp for party_kind doctor (A39-3(iii))
### ICD
- ICD master — added (catalog.icd_code, 5 *IcdMasterCode operations); frontdesk.icd_codes already present as the registration pick list
### Outsource, Interlab, Center Test Mapping (reporting.yaml and partners.yaml read first)
- Outsource — already present (catalog test processing type outsourced / outsource_branch with outsource_name; reporting.yaml uploadOutsourcedReport, listOutsourcedReports, listOutsourcedItems); nothing added
- Interlab — already present (catalog test processing type Branch Transfer and outsource_branch; partners.yaml manifests for partner labs); nothing added
- Center Test Mapping — not added — a centre by test availability matrix changes order routing and the price list, needs its own task and a lead decision; partners.yaml has no centre test list and nothing in this brief's operations uses one
### Non Compliance
- Non Compliance — added (partners.non_compliance_penalty list + partners.non_compliance_event raised, waived or charged once to the ledger)
