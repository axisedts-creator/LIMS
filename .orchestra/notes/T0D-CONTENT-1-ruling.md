TESTS_WRONG — adminpage-eng-1.static.test.ts:102 pins every permission code repo-wide against BASE 052539369, but later lead decisions authorise new non-engagement codes that other contract tasks have since added on main.
- Change in test, line 102 only: apply the "no new code" filter to the engagement family alone, i.e.
  `codes(perms).filter((c) => !baseCodes.has(c) && c.startsWith('engagement.') && !c.startsWith('engagement.content.') && !c.startsWith('engagement.broadcast.'))` must equal `[]`.
  Keep lines 97-99 (base engagement lines unchanged), 103 (settings.manage held by tenant_admin) and 104-106 (operations exist) exactly as they are. Update the comment at 94-96 to cite LD-316, LD-321 and LD-322.
- Why: ADMINPAGE-ENG-1 / T0D-CONTENT-1 owns only the engagement family. CLAUDE.md says lead decisions override chunk text, and inbox brief LD-313 (c) (.orchestra/inbox/T0D-CONTENT-1-arbiter.md:32) allows new codes per module.
- LD-321 (same file, line 33) names partners.sales.read/manage and partners.ticket.read/manage. LD-322 (line 34) names sync.use, sync.device.manage and sync.conflict.resolve.
- lab.verification_policy.read/manage come from LD-316: contracts/permissions.yaml:125-126 and contracts/__tests__/registry-equality.test.ts:21 (LD316_VERLEVEL_CODES).
- T0D-CONTENT-1 does not own contracts/permissions.yaml (brief "files", line 15-19). So no implementation change in this task can satisfy the current line 102 without reverting authorised work on main.
- The billing.* allowance can stay or go once the filter is scoped to engagement.*. With the scoped filter it has no effect, so drop it.
