## debugger round 1
- Cause: no defect in existing code. Verify ran with no writer output: no T0B-TESTIMPORT-1-impl.md, no writer commit, no `catalog/import` code. The 14 failures (5 new files) are `H[operationId] is not a function`, ops absent from catalog.yaml, and docs/ops/CATALOG-IMPORT.md missing. The rest of the suite passes (5902).
- Also blocked: lane/C0-0C (the 6 contract ops, schemas, migration 20261117180000_catalog__add_import_batches) is not merged into lane/C0-0G.
- Fix: none applied. This is the whole feature (6 handlers, xlsx lib or reader, docs), not a smallest-change fix. Merge lane/C0-0C, then run the WRITER step, then re-verify.
