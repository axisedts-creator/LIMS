# T0A-05 impl (writer)
- Files: `packages/test-fixtures/src/{tenants,actors,generators}/index.ts`, `catalog/generate.mjs` + generated `catalog/starter_{catalog_master,price_list}.xlsx`; `tsconfig.json` (rootDir `..`, rewriteRelativeImportExtensions) + `package.json` exports path (dist layout follows rootDir).
- Result: 49/50 pass (verify.cmd); `pnpm typecheck` clean. FAILING: "prefix verification source ... no longer UNVERIFIED" — honest fail, see open point 1.
- [CONV] branch/centre/actor ids hand-assigned in the tenant id family (`…0000000{a|b}{1 branch|2 centre|3 actor}nn`); price_list_id `…a401`.
- [CONV] generator: seed XOR FNV-1a(tenantId) → `createSeededUuidv7` (startMs 2026-01-01Z) + mulberry32 for counts; per patient 1 order, 1 invoice, 1–2 specimens, 1–3 results each; phone `+999` + 9-digit patient number.
- [CONV] xlsx: in-house stored zip (zlib.crc32, DOS time 1980-01-01) → byte-deterministic; inline strings via `neutraliseFormula`; formulas self-checked with `parseFormula`.
- OPEN 1: `+999` NOT checked against ITU-T E.164 list — WebSearch/WebFetch denied in this session. Someone with web access must check https://www.itu.int/pub/T-SP-E.164D, then set `SAFE_PHONE_PREFIX_SOURCE.checkedOn` + note (cite edition, wording for 999).
- OPEN 2: workbooks cover 05-SCHEMA §8 catalog content only; doctor/centre/credit-party price lists, surcharge, tax rules, merged doctor, affiliation have no sheet in these two templates → left to db seeds (T0B-09).
