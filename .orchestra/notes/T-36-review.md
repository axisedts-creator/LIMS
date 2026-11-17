APPROVE

Reviewed `git diff 54d01442..HEAD` (T-36, C3-catalog-pricing).

- Names: the 6 alert rules in `ops/alerts.yaml` (alert/expr/for/severity/route) match 02-TRD §13 L799–804 exactly. Every metric is in the §13 metric table. The CI job name `c3-wording-commission` and the script path match TRD L810. Permissions per kind match TRD rows 34, 96–107 (D-22: catalog_master export not privileged). Error codes `auth.forbidden`, `auth.mfa_required`, `common.not_found`, `common.version_conflict`/`file_not_ready` (D-20) match.
- S-4 / P-10: hand-written branch tests go through the real handlers map. They cover #34 (both permissions, aal1), #96–#107 per kind including aal1 mfa_required on privileged kinds, and #102 publication (summary.analyte_versions|range_sets|critical_sets, publish without manage, kind decides).
- S-1 / AB-5 (exports), S-10 headers plus access log, file_not_ready, S-13 marker hygiene: covered. S-13 is also covered in existing worker/imports probes.
- pending.json `[]` (LD-70, edited by the writer). A stub-scan test asserts all 107 ops are non-stub.
- Tenant isolation: the exports service is tenant-scoped (`tenant_id = $1`, `ANY($2::uuid[])`). No new SQL or tables in this diff, so no new RLS surface.
- Idempotency (#104 R) and the floor x-permission are left to the core pipeline, as documented. Download filename is server-generated ASCII and also sanitised (no header injection).
- No PHI or secrets. Paths are all C3-owned (handlers/ is outside the brief's file list, but it is the chunk's and was needed for done_when).
- Ran `T-36-verify.cmd` equivalent: 6 files / 191 tests passed.
- Not verified: real HTTP pipeline, promtool, CI wiring in pr.yml (C0-0A owns it, CR-C3-009).
