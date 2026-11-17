```
Title: CR-C7-<nnn>: ConfigDocument.update.target / .window must accept null (contract vs C7 TRD)
From chunk: C7            To owner: C0-0C
Type: api
Blocking? yes — C7 06-IMPLEMENTATION-PLAN row API-T06 (E02 getAgentConfig response validation; releases.service.test.ts:25)
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  C7 02-TRD.md:403,416,418,420,422 define the signed config document's update block as
  { channel, target: Target | null, allow_downgrade, window: Window | null } and state null is allowed inside the
  signed document ("opaque payload … type: object, additionalProperties: true"). contracts/openapi/instruments.yaml:6755-6765
  (ConfigDocument.update) declares target ($ref ConfigUpdateTarget) and window (type: object) as non-nullable, so every
  TRD-conformant document (no active release, or no update window) fails E02 response validation. The API cannot re-serialise
  the document without breaking its Ed25519 signature. Producers already emit null (services/worker/src/jobs/instruments/configs.ts:77,
  golden vector services/api/src/modules/instruments/__tests__/fixtures/config/canonical.vector.json:2). Serves AC-13.1 / AC-24.1 (E02/E08 delivery).
Proposed change (exact): OpenAPI diff, contracts/openapi/instruments.yaml, ConfigDocument.properties.update.properties:
  -            target:
  -              $ref: "#/components/schemas/ConfigUpdateTarget"
  +            target:
  +              oneOf:
  +                - $ref: "#/components/schemas/ConfigUpdateTarget"
  +                - type: "null"
               window:
  -              type: object
  +              type: [object, "null"]
  (use the OpenAPI-version-correct null form; 02-CONVENTIONS.md:474. Add both keys to update.required to match TRD:418.)
  Record it as an explicit exception to 02-CV "omit optional fields instead of null" for the signed config payload, as TRD:416 already argues.
Backward compatible? yes — widens the response schema; no client breaks. (Alternative below is NOT backward compatible.)
Tenant/security impact: none — no RLS change, no PHI, no new surface; document stays signed (AB7 anti-rollback unaffected).
IRD/regulatory impact (billing changes only): n/a
Alternatives considered:
  B) Keep the contract and amend TRD:403/418/420/422 to "omit target/window when absent". Requires changing the worker producer
     (configs.ts:77), the canonical golden vector + expected bytes + signature (TS and Go), and the Go agent's parser. Breaking for C7 agent.
  C) Declare ConfigDocument as type: object, additionalProperties: true (TRD:416 wording). Loses contract validation of the payload.
Tests that will prove it:
  releases.service.test.ts:25 (E02 schema-valid) passes with a document whose update.target and update.window are null;
  a contract probe that validates canonical.vector.json against ConfigDocument.
```
