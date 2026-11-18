Title: CR-C0-UICONSOLE2-001: verification queue fields the console shows as a dash / disabled
From chunk: C0 (T0D-UICONSOLE-2)            To owner: C5 (lab, contracts/openapi/lab.yaml)
Type: api
Blocking? no (the console ships with a dash / disabled control; LD-353 rule 6 and the brief: missing data shows as a gap, never invented)
Problem (LD-353 template 2 CONSOLE, brief items 1 and 2):
  1. VerificationQueueItem / ResultDto in the verify stage carry no timestamp, so "Waiting time" and the "Oldest wait" tile are a dash on /lab/verification (approval uses verified_at).
  2. No department or centre field on VerificationQueueItem, so the FilterBar cannot offer "department" and "centre" (listVerificationQueue already forwards department_id, but the row cannot show or group by it).
  3. No hold operation for a queued result, so "Hold (H)" is shown disabled with "not available yet".
Proposed change (exact): owner to decide names; suggested additive optional fields on VerificationQueueItem: `resulted_at` (date-time), `department_id` + department display, `centre_id` + centre display; and an operation to put a result on hold from the queue (or confirm that QC hold is the only hold).
Backward compatible? yes (optional fields; new operation).
Tenant/security impact: no new PHI; same RLS as the queue read.
IRD/regulatory impact: none.
Alternatives considered: computing a wait from other fields (rejected: would invent a time).
Tests that will prove it: uiconsole2.queues.test.tsx "verification queue: the contract has no timestamp" flips to a real hh:mm; a Hold test replaces the disabled one.
