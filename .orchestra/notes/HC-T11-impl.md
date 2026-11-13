# HC-T11 impl (writer)
- Files: new `snapshot.service.ts`, `handlers/{getSyncSnapshot,ackSync}.ts`; edited `index.ts` (wired A2/A4), `repository/routes.repo.ts` (+`updateRouteStamps`), `device.service.ts` (only `export` on shared validators). No change after the ruling ("implementation stays").
- [CONV] route stamps (`last_snapshot_at`/`last_ack_at`) via `updateRouteStamps` WITHOUT version bump: `updateRoute` bumps `routes.version`, the cursor input, so every cursor would go stale at once.
- [CONV] A4: `wipe_completed:true` only completes a `wipe_requested` device (else ordinary ack); only the caller's own routes on the cursor date are stamped; version check (426) + binding before any write; unchanged path writes nothing.
- [CONV] centre-denied route dropped; `handover_centres` via `ctx.core.centres` if present (harness has none -> `[]`).
- Run after ruling (real PG17, `HC-T11-impl-run.log`): 84/84 tests pass, but 3 unhandled rejections make vitest exit non-zero. Cause: test helper `refused` (ack.test.ts:130-132) attaches its handler late. See `HC-T11-dispute.md` (round 2).
- Open: `__tests__/boot.test.ts` (HC-T01) still treats all 26 ops as stubs (already failing since HC-T08). `tsc` clean for touched files.
