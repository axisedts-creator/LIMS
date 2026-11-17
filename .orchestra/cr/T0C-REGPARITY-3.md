Title: CR-C0-REGPARITY-3: RegistrationNumberPreview.next_receipt_no "string or null" (LD-326) conflicts with binding X10 and the OpenAPI lint
From chunk: C0            To owner: C0-0C
Type: api
Blocking? yes — T0C-REGPARITY-3 (C0 06-IMPLEMENTATION-PLAN), and through it T0B-REGAPI-2 (depends on it per LD-326/LD-327).
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  LD-326 / CR-C0-REGAPI-2 part B and the task brief require next_receipt_no to be `type: [string, null]` (null when previewInvoiceNo fails, LD-323).
  spec/program/02-CONVENTIONS.md:466-474 (X10, binding) forbids both `type: [x, "null"]` and `nullable: true`; CI enforces it in
  tools/codegen/lint-openapi.ts:181-182 (rule 1, OAS 3.0 meta-schema: Schema.type must be a single string) and :194 (rule 2, type arrays).
  The brief also requires the existing lint to pass and caps the task at 6 files without listing lint-openapi.ts, so no compliant implementation exists.
  Secondary: staleFiles() already flags contracts/ports/generated/access-actions.ts and db/seeds/003_audit__g_cs_access_actions.sql (LD-326 spec merge); regenerating them exceeds the 6-file cap.
Proposed change (exact) — lead picks one:
  (B, X10-clean, writer-recommended) next_receipt_no: `type: string`, `minLength: 0`, `maxLength: 64`, required; "" when the preview is unavailable (matches LD-323 "the field is empty with a label"). next_receipt_no_label and the example (2083/84-000077 + label) exactly as briefed. No lint change. Tester re-pins regparity3-openapi.test.ts lines 37, 53-56, 60-68, 102-103/110 (null -> ""), 162 (no type arrays at all), 179 (`next_receipt_no: string;`) and regparity2 test line 406 back to `type: "string"`.
  (A, keep LD-326 wording) authorize editing tools/codegen/lint-openapi.ts with ONE allowlist entry (frontdesk.yaml, RegistrationNumberPreview.next_receipt_no) exempting rule 2 and the rule-1 meta-schema error for that node only, recorded as an X10 exception; tests unchanged. File cap raised to 7.
  (C) next_receipt_no optional, omitted when unavailable (X10 "Do"); weaker for the screen.
  For either: allow regenerating the 2 stale files above beyond the cap, or state that the next merge-main task does it.
Backward compatible? no — the new required next_receipt_no_label (all options) and the null/"" value break consumers; only consumer T0D-REGSCREEN-2 is unmerged (LD-326), so nobody breaks.
Tenant/security impact: none — no RLS change, no PHI field, no new public surface. Option A weakens a CI gate (X10) for one node.
IRD/regulatory impact (billing changes only): none — preview only; invoice numbering is assigned at save (LD-323).
Alternatives considered: A, B, C above. A introduces the first 3.1-only construct; oasdiff/dart-dio/Prism behaviour on it is UNVERIFIED (04 T7/T8, cited in 02-CONVENTIONS §4.12).
Tests that will prove it: regparity3-openapi.test.ts schema check passes for a success body and a port-failure body (null or "" plus label); lintRepo reports no frontdesk.yaml violation; generated client types match the chosen shape; oasdiff breaking check records the change as intended.
