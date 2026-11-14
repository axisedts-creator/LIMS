# T0C-04 tests (AC-0C-1.4, 1.5)
- File: `tools/codegen/__tests__/lint-openapi.test.ts` (Vitest + `yaml`; fixtures built in-code, one+ per rule 1-8, P-23, P-8, D-212, AB-20, vendored schema, `_common.yaml`/`core.yaml` shape, `lintRepo` clean).
- Run: `pnpm vitest run tools/codegen/__tests__/lint-openapi.test.ts` (needs vitest + yaml devDeps from T0A-01).
- Fails now: `../lint-openapi` does not exist (import error); also `_common.yaml`, `core.yaml`, `tools/codegen/vendor/` missing.
- API I fixed (implementer must export): `lintOpenapi(files:{name,text}[], ctx)` -> `{rule,file,message}[]`; `lintRepo(rootDir)`; ctx = `{permissions, errors:{code,owner}[], moduleOwners, portOwners, portConsumers}`. rule ids "1".."8", "AB-20".
- Spec gaps (untested, ambiguous): "action endpoint" definition for `status` (rule 7); how rule 6 detects coded-set fields beyond `x-coded-set`+`enum` clash; rule 8 non-identity_auth extensions; `$ref` to `_common.yaml` resolution.
- NOT run: no package.json/node_modules in repo yet.
