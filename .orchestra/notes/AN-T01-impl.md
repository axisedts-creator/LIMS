# AN-T01 impl (writer)
- API: `services/api/src/modules/analytics/{index,permissions,config}.ts`, `handlers/index.ts` (30 stubs from one list [CONV], like instruments).
- Worker: `services/worker/src/jobs/analytics/index.ts` (12 subs, 8 tasks, 4 per_tenant crons, maxAttempts/taskOptions = TRD §9.4 literal). Handlers throw (fail closed, no silent ack).
- Web: `apps/web/src/features/analytics/nav.manifest.ts`; [CONV] reports chord `g r` (spec `g m` clashes with instruments.messages).
- Stub: LIMS_CORE_ENV=dev and NODE_ENV!=production -> `{status:501}` no body; else LimsError common.internal. Env read per call.
- Ran (pnpm install --offline ok): api boot.test 116/117, worker 10/10, web node:test 6/6.
- OPEN: 1 test fails by test defect (instanceof after vi.resetModules) -> see AN-T01-dispute.md.
