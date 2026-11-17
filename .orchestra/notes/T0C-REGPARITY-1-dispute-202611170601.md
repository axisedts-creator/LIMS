# T0C-REGPARITY-1 dispute (writer, round 2) — custom_fields: test demands an open object, the linter (spec) forbids it

The revised test cannot pass as a whole; two of its cases contradict each other on `custom_fields`:

1. `tools/codegen/__tests__/regparity1-openapi.test.ts` "profile_photo_attachment_id is a Uuid and custom_fields a free JSON object": `custom_fields.type === "object"` and
   `additionalProperties` must be undefined, `true` or a schema (so `false` fails), and the ajv cases need `{ blood_group: "O+", referral_note: "synthetic" }` accepted.
2. Same file, "lintRepo reports no violation for frontdesk.yaml": `tools/codegen/lint-openapi.ts:196-197` (02-TRD §5.2 rule 3, closed schemas; 02-CONVENTIONS closed-object rule)
   reports `object needs additionalProperties: false` for every `type: object` schema whose `additionalProperties !== false`.
3. No exception route exists for this field: OPEN_OBJECT_ALLOWLIST (LD-119, `lint-openapi.ts:62-64`) is "exactly ONE entry" and only matches response roots
   with an operation context; `components/schemas` roots and request bodies are walked without one (`schemaRoots`, `lint-openapi.ts:96,108,113`), so NewPatient /
   PatientUpdate / Patient.custom_fields cannot be exempted even with a new entry. Changing the linter or LD-119 is not the writer's call.

Options for the arbiter / lead (pick one):
- (A) Lead decision extending LD-119 to a named second exception: frontdesk `custom_fields` on NewPatient, PatientUpdate, Patient (schema-root keyed), with a lint change
  in the same task (tools/codegen/lint-openapi.ts + its test). Keeps the test as is.
- (B) Test change: `custom_fields` is a closed, bounded shape now, e.g. `type: object, additionalProperties: false, properties: {}` placeholder until T0C-REGPARITY-2 defines
  the definitions (ajv payloads then send `custom_fields: {}`), or an array `[{ code, value }]` with maxItems (closed, lint-clean; DB jsonb object is built by the service).
  Writer recommends (A) only if the lead wants per-tenant keys on the wire now; otherwise (B) with `{ code, value }[]` is spec-clean today.

Everything else in the test is implementable; `db/migrations/20261117100000_frontdesk__add_patient_parity_fields.sql` is written (13 nullable columns, inline CHECKs,
partial unique index, audit exclusion extended, comments/down note) and unaffected by this dispute. The OpenAPI change, codegen and impl notes wait for the ruling.
