Title: CR-C16-T-R2: add optional `kind` filter to R1 listReminders
From chunk: C16            To owner: C16
Type: api
Blocking? no (W9 filters the returned page by kind as a stop-gap [CONV])
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
04-UI-UX W9 lists a Kind filter (US-EN-23). R1 `GET /v1/engagement/reminders` (02-TRD R1) has no `kind` param and the API ignores it, so filtering only within a fetched page of 50 rows; pagination is not kind-aware.
Proposed change (exact): R1 query gains `kind?: 'custom' | 'follow_up' | 'booking'` (enum = engagement.reminder.kind); service adds `AND kind = $n` when present; 400 common.validation_failed on unknown value.
Backward compatible? yes (new optional query param)
Tenant/security impact: none; RLS unchanged; no new PHI field or surface.
IRD/regulatory impact: n/a
Alternatives considered: hide the Kind select (loses a W9 filter); client-side filter per page (current stop-gap; incomplete pages).
Tests that will prove it: API test R1 `kind=follow_up` returns only follow_up rows; 400 on `kind=x`; W9 test asserts `kind` forwarded to R1.
