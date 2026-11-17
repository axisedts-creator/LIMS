# T0C-REGPARITY-1 dispute (writer) — tests unsatisfiable together; stopped before implementing

**Conflict.** `tools/codegen/__tests__/regparity1-openapi.test.ts` requires BOTH
- `lintRepo` reports no violation for frontdesk.yaml (test "lintRepo reports no violation"), AND
- `nullable: true` on every new field of Patient and PatientUpdate (test "Patient and PatientUpdate new fields are nullable"), plus ajv accepting `null` values
  (tests "PatientUpdate takes the new fields, null clears" → `{ address_tole: null, government_id_number: null, custom_fields: null, title: null }`, and
  "Patient (single read) carries the new fields, all nullable" → all 13 = null), and the title / id-type enum comment "a nullable enum lists null".

The linter rejects `nullable` in any schema: `tools/codegen/lint-openapi.ts:23` FORBIDDEN_SCHEMA_KEYS, rule 2 at line 193, which transcribes
spec/chunks/C0-foundation-contracts/02-TRD.md §5.2 rule 2 ("Rejects: `nullable`, `type` arrays, ...", CV §4.12). No contract file in `contracts/openapi/` uses `nullable: true`.
A `nullable` beside `$ref` (profile_photo_attachment_id → Uuid) is also rule 2 "$ref with sibling keys". So 13×2 nullable fields = 26+ lint violations; no shape passes both.

**Repository convention (what the writer would implement).** Optional = property absent (not `null`) in responses; clearing on update = `PatientUpdate.unset[]`
(existing: birth_on, phone_e164, email, address_text). The tester's own "PatientUpdate can clear every new optional field: nullable OR listed in unset[]" test already accepts this.

**Proposed test change (tester / lead ruling needed; writer may not edit tests):**
1. Drop the `isNullable` loop (line 85) — keep the maxLength loop.
2. Title / id-type enums: no `null` entry (filters at lines 97 and 112 are harmless; keep).
3. PatientUpdate ajv: replace the null-clears payload (line 168) with `{ unset: ["address_tole", "government_id_number", "custom_fields", "title"] }`; `unset` enum gains the 13 new fields, `maxItems` ≥ 17, items `maxLength` ≥ 27 (`profile_photo_attachment_id`).
4. Patient ajv (line 176): replace the all-null payload with the base payload (new fields absent), already covered by line 177 — delete line 176.
The pgTAP suite is unaffected (DB columns stay nullable, no default).

Alternative (needs a CR against 02-TRD §5.2 rule 2, not recommended): allow `nullable` in contracts. Not in the writer's authority.
