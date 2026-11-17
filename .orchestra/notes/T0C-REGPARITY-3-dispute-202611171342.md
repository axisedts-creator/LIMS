# T0C-REGPARITY-3 dispute (writer) — needs a lead ruling, writer stopped, no files changed

KIND: brief/LD-326 vs binding X10 + CI lint (not a plain TESTS_WRONG; tests faithfully pin the brief).

Facts:
1. spec/program/02-CONVENTIONS.md:466-474 (X10, binding): documents use only the 3.0.3 ∩ 3.1 subset; the Don't column lists BOTH `nullable: true` and `type: [x, "null"]`; "Omit optional fields instead of null".
2. tools/codegen/lint-openapi.ts:181-182 (rule 1) validates every file against vendor/oas-3.0-schema.yaml, where Schema.type is `type: string, enum: [...]` (vendor line 260-268). A `type: [string, null]` fails rule 1, not only rule 2 (line 194). The tester note only mentions rule 2.
3. So regparity3-openapi.test.ts "lintRepo reports no violation for frontdesk.yaml" plus "next_receipt_no: type [string, null]" can only both pass if lint-openapi.ts is changed to (a) skip rule 2 for this path AND (b) strip/skip this node before the OAS 3.0 meta-schema validation. That edits a CI gate outside the brief's file list ("at most 6 files"; lint not listed), and contradicts X10. LD-119 precedent was one rule-3 exemption, not a meta-schema bypass.
4. Separately (tester note line 7): staleFiles() already flags contracts/ports/generated/access-actions.ts and db/seeds/003_audit__g_cs_access_actions.sql (LD-326 spec merge); regenerating them is outside the 6-file cap.

Options for the lead:
- (A) Keep LD-326 wording: authorize editing tools/codegen/lint-openapi.ts with ONE allowlist entry (module frontdesk, schema RegistrationNumberPreview, property next_receipt_no) exempting rule 2 type-array and the rule-1 meta-schema error for that node only, and record it as an X10 exception. Tests unchanged. Cost: first 3.1-only construct in the contracts; oasdiff/dart-dio/Prism behaviour on it is UNVERIFIED (04 T7/T8).
- (B) X10-clean, recommended: next_receipt_no stays `type: string`, minLength 0, maxLength 64, required; "" (empty) when the preview is unavailable — LD-323 itself says "the field is empty with a label". Label field and example as briefed. No lint change. Tester re-pins regparity3 lines 37, 55-56, 102-103/110 ("null" -> ""), 162 (expect no type arrays at all), 179 (`next_receipt_no: string;`), and regparity2:406 back to `type: "string"`.
- (C) X10-clean: next_receipt_no optional (omitted when unavailable). Weaker for the screen; not recommended.
Also rule on item 4 (allow the 2 regenerated files beyond the cap).
