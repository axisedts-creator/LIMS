# T0D-MSGDESK-1 dispute: core/nav pins are stale on main (not this task)
- apps/web/src/core/nav/__tests__/nav-complete.build.test.ts:17 pins billing == 9; main has 22 (T0D-FINCTRL-1 / T0D-MISREPORTS-1 added entries; brief says nav entries are additive).
- nav-complete.admin-pack.test.ts:109 and two siblings pin the corp_admin hidden list and "no lab.result.approve"; main now shows lab.approval to corp_admin (see .orchestra/notes/T0D-NAV-COMPLETE-1-admin-hidden.md).
- MSGDESK adds only engagement.msg_templates, engagement.msg_broadcasts, partners.tickets. All 97 MSGDESK-relevant tests pass.
- Ask: own task to re-pin these two test files, or exclude them from the T0D-MSGDESK-1 verify command.
