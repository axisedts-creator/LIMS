Title: CR-C12-T01b: inventory.yaml local schema `Code` collides with _common.yaml `Code` at boot
From chunk: C12            To owner: C0 (T0C-10.C12 inventory.yaml / core loader bundleRefs)
Type: bug
Blocking? yes — C12 T-01 done_when "API boots"; boot.test.ts 2/19 fail.
Problem:
  contracts/openapi/inventory.yaml now exists (LD-103) but boot fails: `spec: $ref _common.yaml#/components/schemas/Code collides with a local definition`
  (core/module.ts:138 bundleRefs.place). _common Problem/FieldError ref `#/components/schemas/Code` (string); inventory.yaml:10873 defines its own
  local `components.schemas.Code` (object: code/display/is_active/reason_group...) for TRD §5 ops 28/29 (`Code[]`, `Code`). Same pointer, different node.
Proposed change (pick one):
  A) inventory.yaml: rename the local object schema (TRD §5 says `Code`; name not in spec, so C0/lead must choose, e.g. CodedSetEntry), update refs at lines 2424, 2542, rerun codegen + mock:inventory.
  B) core bundleRefs: namespace colliding component names per module.
Backward compatible? A yes (same wire JSON). 
Tests that will prove it: services/api inventory boot.test.ts (19/19), core boot.test.
Debugger did not rename: never invent a name (CLAUDE.md); generated clients would change.
