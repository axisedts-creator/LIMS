TESTS_WRONG — the test asserts `nullable: true` / `null` values on the wire, which the spec forbids; "nullable" in the brief applies to the DB columns only.

Reasons:
1. spec/program/02-CONVENTIONS.md:348 — "No `null` on the wire. Absent optional field = omitted. ... Clearing an optional master-data field uses `PATCH` with `"unset": ["field_name"]`."
2. spec/program/02-CONVENTIONS.md:474 — "Omit optional fields instead of null" vs forbidden `nullable: true`.
3. spec/chunks/C0-foundation-contracts/02-TRD.md:337 (§5.2 rule 2) — linter rejects `nullable` and `$ref` with siblings; tools/codegen/lint-openapi.ts:23 transcribes it. The test's own "lintRepo reports no violation" case therefore cannot pass alongside the nullable cases: the test contradicts itself, the spec does not.
4. CONVENTIONS outranks chunk docs and the task brief; "additive and nullable only" is satisfied by nullable DB columns (02-CONVENTIONS.md:765 "add nullable") and non-required, clearable contract fields.

Changes to tools/codegen/__tests__/regparity1-openapi.test.ts (tester):
- line 7 header comment: replace "fields are `nullable: true`" with "fields are optional (not required) and clearable via PatientUpdate.unset[]".
- line 84-85: drop the `isNullable` loop; keep the bounded-string (maxLength) assertions; rename the case accordingly. Instead assert no new field carries `nullable`.
- lines 97, 112: keep the `!== null` filters (harmless); drop the "nullable enum lists null" comment; enums must contain no `null`.
- lines 126-133: require every NEW field in `unset.items.enum` (drop the `isNullable ||` alternative); keep the maxItems check.
- line 168: replace payload with `{ unset: ["address_tole", "government_id_number", "custom_fields", "title"] }` → valid; add `{ title: null }` → rejected.
- line 171-176: rename case to "carries the new fields, all optional"; replace the all-null payload with the base payload (new fields absent) plus one payload with all new fields set to valid values; add an all-null payload → rejected.
pgTAP/migration tests unchanged (DB columns stay nullable).
