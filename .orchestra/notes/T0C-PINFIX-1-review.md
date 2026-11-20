APPROVE
# T0C-PINFIX-1 review
- Diff bc09c608..HEAD touches only contracts/__tests__/t0d-12d.test.ts plus own notes; no yaml/spec/handler/service/web/migration/lint change.
- Total pin -> floor (>= 143+20+11) plus unique-id check; LD-112/LD-130 row checks (id, path, permission, origin, owner) unchanged.
- Contiguous + next-row cases -> one relative-order case: each LD-112 id exactly once, ascending order, after staff.platform.dead_letter, before staff.quality.qc_run. Matches brief (2). Raw comment-line case kept unchanged (still passes, brief (3)).
- Comments cite T0C-PINFIX-1 / LD-339 / LD-337. No names invented, no PHI, no secrets.
- Reviewer run: `pnpm exec vitest run contracts/__tests__/t0d-12d.test.ts contracts/__tests__/registry-equality.test.ts` -> t0d-12d all green; registry-equality 2 reds (errors.yaml vs IC §8, permissions.yaml fixed_actor_permissions partners.ticket.read/manage vs IC §11) = pre-existing yaml/IC drift, untouched by this diff, named in notes per brief. Routes-vs-IC §7 case green.
- Open for lead: route IC §8/§11 and ports vs IC §4 drift to a sync task.
