APPROVE
Scope: C3 T-20 re-review (Import API #96–#101, #103), diff 356e46c..HEAD. Verify run: 162/162 pass (imports.test.ts + imports.probes.test.ts).
Prior CHANGES resolved:
1. `infra/monitoring/rules/tests/instruments.test.yml` no longer in the lane diff; only owned C3 paths + .orchestra notes changed.
2. #96 downloadTemplate writes access log `data.export` / `catalog_file` / detail.kind / outcome allowed (imports.service.ts accessLog).
3. #101 downloadImportReport writes access log with entityId = report_file_id, only after the file is found.
4. Tests assert exactly one entry for #96 and #101, none on denied paths, none for #97–#100 and #103 (imports.test.ts:700-734).
Names, tenant binding on every statement, advisory-lock dedupe + 2-active limit, same-tx enqueue, P-10 per-kind asserts, 413/415/429: unchanged from the earlier review and still match the spec.
