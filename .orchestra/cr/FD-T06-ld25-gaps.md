Title: CR-C4-FD-T06-001: LD-25 downtime back-entry fields have no contract, column, setting or audit action
From chunk: C4            To owner: C0-0B (schema), C0-0C (api), C2 (TenantSettings)
Type: schema | api | port
Blocking? no (FD-T06 validates + audits in a minimal way; stored columns / tenant setting / invoice downtime_ref wait on this)
Problem: LD-25 (2026-11-07) requires `entry_mode`/`occurred_at`/`downtime_ref` on F9, stored on the order, a tenant setting `downtime_backentry_max_hours` (default 72), `downtime_ref` on the invoice, and an audit entry. Today: CreateRegistrationRequest is additionalProperties:false without the 3 fields; frontdesk.orders has no columns; TenantSettings has no such key; BillingCommandPort.issueOrderInvoice has no downtime param; audit.g_cs_access_actions has no order/registration action.
Proposed change (exact): (1) OpenAPI: add the 3 fields to CreateRegistrationRequest (+ RegistrationDraft not needed). (2) DDL: frontdesk.orders `entry_mode text NOT NULL DEFAULT 'live' CHECK IN ('live','downtime_backentry')`, `occurred_at timestamptz`, `downtime_ref text CHECK (char_length <= 32)`. (3) TenantSettings.downtime_backentry_max_hours (int, default 72). (4) issueOrderInvoice input `downtimeRef?: string`. (5) access action `order.register` (or similar) in audit.g_cs_access_actions.
Backward compatible? yes
Tenant/security impact: none new (P0/P2 data); no PHI.
IRD/regulatory impact: tax treatment of hand-written bills is UNVERIFIED (LD-25); nothing is sent to CBMS back-dated.
Alternatives considered: FD-T06 now uses constant 72 h, audits via `patient.view` with detail {entry_mode, downtime_ref, occurred_at}, and does not persist the fields.
Tests that will prove it: FD-T06 downtime.test.ts (limits) + new column/setting/invoice assertions.
