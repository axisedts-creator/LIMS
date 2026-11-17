TESTS_WRONG — tenant.realchain.test.ts pins the pre-PROVPACK provisioning statement list; the task now requires the pack step inside provisioning.
Reasons:
- spec/program/11-ROLE-MATRIX.md:20 (R6): pack templates are custom roles "seeded at tenant provisioning (S14)" — so provisioning SHOULD write pack roles, grants and their role.change access-log rows; the old list omits them.
- Task brief done_when (2) (.orchestra/inbox/T0B-PROVPACK-1-arbiter.md:23) and binding LD-301 (:34): provisioning applies the default pack (elabcorp_default) through role-pack.service, additive, in the same scoped block.
- The assertions at L173-178, L208 and L209 were written for T0B-PROVFIX-2 before this requirement existed; they assert "nothing else happens", which the spec no longer supports.
Change in the test (no weakening of any other assertion):
1. L173-178: after 'app.enqueue_job' insert the pack block exactly as emitted by role-pack.service (the 2 role SELECTs, then per PACK role 'core.roles','core.role_permissions','audit.access_log'), then the final 'audit.access_log'. Keep exact toEqual order.
2. L208: expect toHaveLength(ROLE_CODES.length + PACK.roles.length), PACK read from role-packs.data.yaml (not a hard-coded 19).
3. L209: select the access_log row whose action is 'tenant.lifecycle_change' (assert exactly one such row) and keep the same values check; additionally assert PACK.roles.length rows with action 'role.change'.
L181-191 (claims) and L212-219 (rollback) stay unchanged and must still pass.
