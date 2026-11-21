APPROVE
Range 517f55a41..HEAD (tester 8cd281de4, writer e8f0c9208, debugger 9c865ea49).
- Engagement STALE updates match the arbiter ruling exactly: tables 43->45 (rt now 41 tenant + 3 G + event_inbox), indexes 51->52 (portal_content__tenant_id_kind_sort_order__idx), audit triggers 24->26, FK schema list +identity (upstream C0, composite tenant FK). Each cites migration 20261117130000 / T0C-CONTENT-1 / LD-313/LD-325. No assertion deleted or weakened; :91 and :123 unchanged; per-table probe and audit-iff-class checks now cover the 2 new tables.
- Fixture diffs (probe-rows/engagement.sql, lab.sql) are generator output, not hand edits: `node db/tools/gen-isolation-probes.ts --check` = "ok (467 probe files, 19 fixture files current)"; files carry the GENERATED header. In-scope (db/tests/**), consistent with LD-367 (no hand edit). Note only: T0B-GREEN-3-tests.md says "not edited by tester", which is inaccurate (it was regenerated in 8cd281de4); not a code defect.
- LD-365 migrations/policy/inventory are not in this range (landed before 517f55a41); impl note describes them per LD-365; 3 nonblocking CRs present in .orchestra/cr.
- No secrets, no PHI, synthetic ids only; no spec/ edits; names copied from migrations.
- Evidence: .orchestra/out/T0B-GREEN-3-debug-rerun.log (core+definers+engagement+identity, 0 "not ok", 247 s). Reviewer did not rerun the suites.
