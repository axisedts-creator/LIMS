# HC-T11 impl (writer)
- Files: new `snapshot.service.ts`, `handlers/{getSyncSnapshot,ackSync}.ts`; edited `index.ts` (wired A2/A4), `repository/routes.repo.ts` (+`updateRouteStamps`), `device.service.ts` (only `export` on shared validators).
- [CONV] route stamps (`last_snapshot_at`/`last_ack_at`) via `updateRouteStamps` WITHOUT version bump: `updateRoute` bumps `routes.version`, which is the cursor input, so every cursor would go stale at once.
- [CONV] A4: `wipe_completed:true` only completes a `wipe_requested` device (else ordinary ack); cursor decoded, only the caller's own routes on the cursor date are stamped; version check (426) + binding before any write; unchanged path writes nothing.
- [CONV] centre-denied route (assertRole visit.read + centreId) is dropped; `handover_centres` via `ctx.core.centres` if present (harness ctx has none -> `[]`, not asserted).
- Run (real PG17, `HC-T11-impl-run.log`): 80 passed / 4 failed of 84. Failures = dispute (`HC-T11-dispute.md`): latitude/longitude asserted as numbers but contract is DecimalString (string); 3 perf tests fail on Windows (`setTimeout(10)` = 16.5 ms: 669 ms unchanged / ~2.05 s changed vs 500 ms / 2 s).
- Open: `__tests__/boot.test.ts` (HC-T01) still treats all 26 ops as stubs; it already fails on `listHomeVisits` (HC-T08), not caused by this task. `tsc` clean for touched files.
