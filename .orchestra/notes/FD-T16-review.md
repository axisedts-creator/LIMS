APPROVE
Scope: cb319bf4..HEAD = probe fixture changes only (crossCentre.live.test.ts:55-59, crossTenant.live.test.ts:64-66) + notes. No handler/SQL/RLS/permission/error-code change in range.
- Matches ruling round 3 fix (a): objs() orders sharing the F10 window are seeded into the lab/billing fakes handed to fire(); seed shape mirrors the round-1 control (crossCentre.live.test.ts:32-33).
- No weakened assertion: A2 exclusion still checked for both s2 and the objs() A2 order (crossCentre :64-65); crossTenant zero-B-rows assert untouched.
- Synthetic IDs only, no PHI, no secrets; only owned path services/api/src/modules/frontdesk/__tests__/probes/. LD-70: pending.json untouched.
- Not re-run by reviewer; writer note reports FD-T16-verify 225/225 on Docker PG17.
