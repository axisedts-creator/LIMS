Title: CR-C17-HC-T17-C1: import the five homecollection alert rules from services/worker/src/jobs/homecollection/alerts.yaml
From chunk: C17
To owner: C1
Type: shared-lib
Blocking? no (the rule file ships in C17; the alerts only fire once C1 loads it)
Problem: 02-TRD §14 and 08 A13 P-14 register five C17 alerts with C1. The rules exist as a file owned by C17 but nothing loads them into the C1 alert pipeline.
Proposed change (exact): load services/worker/src/jobs/homecollection/alerts.yaml into the C1 Prometheus rule set (one rule group `homecollection`, five alerts: HomecollectionHeldOpen, HomecollectionPush5xx,
  HomecollectionDeadLetter, HomecollectionClockSkew, HomecollectionDevicesStale). On import C1 adds the `team` and `runbook_url` labels and the routes from the TRD table (HeldOpen and DevicesStale: tenant ops e-mail;
  Push5xx, DeadLetter, ClockSkew: The LIMS provider on-call). expr / for / severity are left as written. `promtool check rules` must report "SUCCESS: 5 rules found". The rules read lims_http_requests_total,
  lims_core_dead_letters_total (C0) and the lims_homecollection_* metrics (see CR HC-T17-registry).
Backward compatible? yes (additive rule group).
Tenant/security impact: none; the only label is tenant_id, no visit / device / patient / barcode label.
Alternatives considered: copying the five rules into a C1 file (drift risk against the TRD table).
Tests that will prove it: services/api/src/modules/homecollection/__tests__/observability/observability.test.ts ("alerts.yaml" group, incl. promtool when installed); C1 import check in its own CI.
