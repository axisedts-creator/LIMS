Title: CR-C4-FD-T15-001: all-centre read/update path for F7 anonymisePatient (open-order check + TRF deactivation)
From chunk: C4            To owner: C0-0B
Type: schema
Blocking? no (FD-T15 ships fail-closed: F7 returns 403 auth.forbidden unless IdentityPort.getActor().centreScope.all is true)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  US-FD-16.1 / 03-APP-FLOW §2.18: anonymisation must be blocked by any open order of the patient and must delete all TRF objects (REQ-SEC-139, 08 A13 P-12 c).
  frontdesk.patients RLS is tenant-only, but frontdesk.orders and frontdesk.trf_attachments RLS is tenant+centre
  (db/migrations/20261105001600_frontdesk__create_frontdesk_schema.sql:511, :563). A centre-scoped tenant_admin holding
  frontdesk.patient.anonymise therefore cannot see other-centre open orders or TRF rows: the block would be skipped silently and
  other-centre TRF objects would stay. C4 now denies such admins entirely.
Proposed change (exact): one SECURITY DEFINER function in schema frontdesk (listed in db/meta/definer-inventory.yaml), tenant-filtered by
  current tenant claim, callable only when the caller holds frontdesk.patient.anonymise, that for one patient_id
  (a) returns id, status of orders with status in ('pre_registered','registered','in_progress') across all centres, and
  (b) sets is_active = false on all trf_attachments of the patient across all centres, returning bucket, object_path.
  Names to be fixed by C0-0B; C4 will call it from patient.service.ts anonymisePatient and drop the centreScope.all gate.
Backward compatible? yes — additive.
Tenant/security impact: no RLS relaxation; DEFINER bypasses centre scope only for this patient-scoped privileged (aal2) action; no new PHI field; no new public surface (REQ-SEC-139, REQ-SEC-067).
IRD/regulatory impact (billing changes only): n/a
Alternatives considered: (1) keep the fail-closed gate (current; centre-scoped admins cannot anonymise); (2) relax orders/trf_attachments RLS to tenant-only — rejected, widens every read.
Tests that will prove it: admin/anonymise.test.ts — centre-scoped aal2 tenant_admin with an open order at another centre gets frontdesk.order_not_editable; with none, all TRF rows of every centre become inactive and their objects are deleted.
