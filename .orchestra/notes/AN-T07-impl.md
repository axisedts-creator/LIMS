# AN-T07 impl (writer)
- Files: `repository/labels.repo.ts` (listDepartments/Tests/Referrers/Instruments), `service/labels.service.ts` (department/test/referrer/instrument/centre/branch/staffLabels).
- Repo: one bound SELECT on the published view, explicit columns, tenant `$1`, ids `= ANY($2)`, no is_active predicate; `ids: []` returns `[]` with no query.
- Service: Map<id, entry>, absent = no row. canonicalId = canonical_referrer_id ?? own id. Instrument label = `display_name (instrument_code)`.
- Staff [CONV P-17]: memberships.list activeOnly:false, ids de-duped, chunks <=200, memo per ctx (WeakMap), failed chunks dropped from memo.
- Centres/branches via ctx.core with activeOnly:false. Core errors and DB errors propagate unchanged.
- Open: ctx type is a structural subset (`LabelsContext`); swap to HandlerContext when AN-T08 wires handlers. No tests disputed.
- Run: 2 files, 60/60 pass; tsc shows no errors in these files.
