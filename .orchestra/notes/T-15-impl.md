# T-15 impl (writer) — doctors #60–#66
- Files: service/referrers.service.ts (new), handlers/referrers.handlers.ts (new), handlers/index.ts (7 stubs -> spread), repo/masters.repo.ts (MasterTable += doctors), probes/pending.json (7 ids removed, 79 -> 72).
- Result: 266/267 pass (doctorsDb 8/8, wording 4/4, handlers all, service 217 minus 1). Failing: `['r_s', []]` — test is wrong, see T-15-dispute.md; not changed.
- [CONV] auto code = upsert `code_counters` (`next_value` = next to hand out), DR + 5-digit pad; merged doctor: verify and reactivate -> 409 catalog.version_in_use; merge of an already-merged source -> 409 same code; unknown/foreign merge target -> 400 validation_failed.
- [CONV] unknown body keys are reported at path "" (never echo the key, AB-20); write ops return contacts (route needs manage), only getDoctor consults IdentityPort.getActor (fail closed).
- Open: auto code colliding with an existing explicit `DR00001` -> 409 code_duplicate (no skip/retry; spec gap, maybe CR). Re-pointed doctors get version+1. created_at cursor is ms precision (ponytail note in code). Price-list reassignment at merge = T-17.
