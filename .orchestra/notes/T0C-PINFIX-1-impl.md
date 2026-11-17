# T0C-PINFIX-1 impl (writer)
- Files changed: none beyond the tester commit 1e50dda88 (task is tests-only; brief forbids yaml/spec/handler/service/web/migration/lint edits).
- Run: `pnpm exec vitest run contracts/__tests__/t0d-12d.test.ts` -> 15/15 pass (202 routes on main, floor 174, LD-112 relative order).
- registry-equality.test.ts: routes == IC §7 green; 2 reds remain (errors.yaml vs IC §8, permissions.yaml vs IC §11: partners.ticket.read/manage in fixed_actor_permissions) = yaml/IC drift, not a stale pin, not fixed.
- Whole contracts/__tests__: 246 pass / 19 fail; 17 in ports.test.ts (ports/*.ts vs IC §4 blocks) + the 2 above. None is a route total/adjacency pin.
- [CONV] No other test file touched (brief: fix only stale route-count/adjacency pins).
- Open: lead to route IC §4/§8/§11 vs yaml/ports drift to a sync task.
