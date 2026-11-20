# T0D-MSGDESK-1 dispute: core/nav pins are stale on main (not this task)
- apps/web/src/core/nav/__tests__/nav-complete.build.test.ts:17 pins billing == 9; main has 22 (T0D-FINCTRL-1 / T0D-MISREPORTS-1 added entries; brief says nav entries are additive).
- nav-complete.admin-pack.test.ts:109 and two siblings pin the corp_admin hidden list and "no lab.result.approve"; main now shows lab.approval to corp_admin (see .orchestra/notes/T0D-NAV-COMPLETE-1-admin-hidden.md).
- MSGDESK adds only engagement.msg_templates, engagement.msg_broadcasts, partners.tickets. All 97 MSGDESK-relevant tests pass.
- Ask: own task to re-pin these two test files, or exclude them from the T0D-MSGDESK-1 verify command.

## Round 4 update
- Remaining 2 failures: nav-complete.admin-pack "NOT lab.result.approve" and "Approve entry not visible". Tests follow spec R5 (11-ROLE-MATRIX.md line 18, section 3.3 line 81).
- Real defect on main: services/api/src/modules/identity/role-packs/role-packs.data.yaml corp_admin (line 125; also lab.result.verify/amend, lab.qc.capture, inventory.po.approve) differs from spec/program/11-ROLE-MATRIX.data.yaml. Needs an identity-lane task (trim API pack, re-apply role pack, founder step) or a founder CR if the widening was intended. Not MSGDESK.
- Ask: exclude vitest.nav-complete.config.ts from the T0D-MSGDESK-1 verify command until that task lands.
