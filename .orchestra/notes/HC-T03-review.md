APPROVE
Diff c9b2a498..HEAD touches only repositories.test.ts + orchestra notes; no repository/*.repo.ts change.
- Ruling item 1: the line-142 RLS-bypassed id-swap assertion is skipped only when listArg is empty; the tenantId-swap assertion still runs. Matches the ruling.
- Ruling item 2: the assigned visit now carries a newly seeded tenant-A order (frontdesk.orders + lab.orders, same pattern as seedWorld helpers.ts:59). Satisfies visits__order_when_active__ck (05-SCHEMA.md:267) and visits__order__fk (05-SCHEMA.md:253). The lab.orders columns and values match the lab migration CHECKs (visit_type, source, patient_sex).
- Names are verbatim. No PHI and no secrets. All paths are owned (the frontdesk helpers are imported read-only).
- Reviewer ran tests/homecollection/HC-T03.pg.sh on PG17: 2 files, 186/186 pass.
Non-blocking, already noted in impl.md: the P-1 stand-in DDL lacks the C0 transition_guard triggers, and cross-centre scoping is left to the handler layer.
