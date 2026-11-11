Title: CR-C5-T14: LD-25 downtime back-entry has no contract/DDL/audit-code home for result entry
From chunk: C5            To owner: C0-0C (api), C0-0B (schema, audit seed)
Type: api + schema
Blocking? no (T-14 ships with handler/service-level LD-25 validation, audit and store seam; see below)
Problem: LD-25 (2026-11-07) requires bulk result entry to accept `entry_mode` / `occurred_at` / `downtime_ref`, store both and show "Entered after downtime".
 (1) contracts/openapi/lab.yaml bulkEnterResults body is `additionalProperties: false` without those fields, so the core schema check rejects them before the handler runs.
 (2) lab.results / lab.result_observations have no columns for occurred_at / downtime_ref (the service hands them to store.saveEntry as `downtime`).
 (3) audit.g_cs_access_actions has no code for a result entry; T-14 uses `lab_result.enter` (ENTRY_AUDIT_ACTION), which fails the DB check until seeded.
 (4) tenant setting `downtime_backentry_max_hours` has no column; the handler uses the default 72 h.
Proposed change (exact): add optional `entry_mode` (enum live|downtime_backentry), `occurred_at` (IsoUtc), `downtime_ref` (string 1..32) to the bulkEnterResults request; add nullable `downtime_occurred_at timestamptz`, `downtime_ref text CHECK (char_length <= 32)` to lab.result_observations (and expose in ResultDto history); seed `lab_result.enter` in audit.g_cs_access_actions; add lab.lab_settings.downtime_backentry_max_hours integer DEFAULT 72.
Backward compatible? yes (all additive/optional).
Tenant/security impact: none new; no value or back-dated instant goes on the event bus (S-12).
Tests that will prove it: result.service.enter.test.ts / resultEntry.handlers.test.ts (LD-25 blocks) + a contract test once the schema carries the fields.
