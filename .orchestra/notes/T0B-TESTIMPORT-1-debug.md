## debugger round 1
- Cause: no defect in existing code. Verify ran with no writer output: no T0B-TESTIMPORT-1-impl.md, no writer commit, no `catalog/import` code. The 14 failures (5 new files) are `H[operationId] is not a function`, ops absent from catalog.yaml, and docs/ops/CATALOG-IMPORT.md missing. The rest of the suite passes (5902).
- Also blocked: lane/C0-0C (the 6 contract ops, schemas, migration 20261117180000_catalog__add_import_batches) is not merged into lane/C0-0G.
- Fix: none applied. This is the whole feature (6 handlers, xlsx lib or reader, docs), not a smallest-change fix. Merge lane/C0-0C, then run the WRITER step, then re-verify.

## debugger round 2
- Cause unchanged: still no writer output (no catalog/import code, no impl note, no docs/ops/CATALOG-IMPORT.md) and lane/C0-0C contract ops not merged. Failures are missing handlers, not a defect.
- Fix: none applied (whole feature, not a smallest change). Needs merge of lane/C0-0C, then the WRITER step, then re-verify.

## debugger round 3
- Cause unchanged: no writer output (no catalog/import code, no impl note, no docs/ops/CATALOG-IMPORT.md); lane/C0-0C (T0C-TESTIMPORT-1 contract ops) still not merged into lane/C0-0G. Failures = `H[operationId] is not a function` (missing handlers), not a defect.
- Fix: none applied (whole feature, not a smallest change; tests must not be touched). Needs merge of lane/C0-0C, then the WRITER step, then re-verify.
