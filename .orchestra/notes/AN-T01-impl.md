# AN-T01 impl (writer)
- API: `services/api/src/modules/analytics/{index,permissions,config}.ts`, `handlers/index.ts` (30 stubs from one list [CONV], like instruments).
- Worker: `services/worker/src/jobs/analytics/index.ts` (12 subs, 8 tasks, 4 per_tenant crons, maxAttempts/taskOptions = TRD §9.4 literal). Handlers throw (fail closed, no silent ack).
- Web: `apps/web/src/features/analytics/nav.manifest.ts`; [CONV] reports chord `g r` (spec `g m` clashes with instruments.messages).
- Stub: LIMS_CORE_ENV=dev and NODE_ENV!=production -> `{status:501}` no body; else LimsError common.internal. Env read per call.
- Ran after ruling (tests revised; no impl change needed): api boot.test 117/117, worker 10/10, web node:test 6/6.
- OPEN: none for AN-T01. Spec `g m` chord clash (04-UI-UX §1) still wants upstream CR.
