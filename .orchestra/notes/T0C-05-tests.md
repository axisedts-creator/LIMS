# T0C-05 tests (AC-0C-2.1; 08 §4.1 permission rules)
- File: `tools/codegen/__tests__/codegen.test.ts` (Vitest; reads real contracts/, IC §13.1/§4.x, no extra fixtures).
- Run: `.orchestra\notes\T0C-05-verify.cmd` (= `cd tools\codegen && npx vitest run __tests__/codegen.test.ts`).
- Fails now: `tools/codegen/codegen.ts` and `gen-permissions.ts` do not exist (import errors).
- API fixed for implementer (header of the test): `generateAll(root)->Record<path,text>`, `writeAll(root)`, CLI `--check`, `checkPermissionRules(doc, extraGrants?)->{rule:R1|R2|R3,code,message}[]`; REQUIRED output paths listed in test.
- Covers: double-run byte equality (+other cwd, no timestamps/abs paths/CRLF), committed==generated, content of error-codes/permissions(+FIXED_ACTOR_PERMISSIONS, placeholder expanded)/seed SQL/access-actions/port-consumers/events/Operations/routes, R1-R3 rules.
- Not tested (spec-ambiguous): Dart client file layout (only "some .dart under api-client-dart/"), exact TS client type text, IC C-number→module mapping beyond 3 spot-checks, `routes.g.dart` location.
- NOT run: implementation absent; tests only confirmed to fail on missing modules.
- CR-C0-0C-004: `__tests__/c4-openapi.test.ts` lines 109-110,137 renamed listCreditParties->listCreditAccounts, getCreditParty->getCreditAccount. Inventory test fails until billing.yaml is renamed; other c4 failures (E3 idempotency justification, rule 4) are unrelated to this edit.
