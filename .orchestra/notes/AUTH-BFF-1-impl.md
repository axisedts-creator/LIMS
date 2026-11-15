# AUTH-BFF-1 impl (writer)
- core/module.ts: HandlerContext `readonly bffKey?: BffKind | undefined` (type-only import).
- core/pipeline/index.ts: PipelineCall.bffKey; buildCtx sets `bffKey: c.bffKey` (own key, frozen with ctx) [CONV LD-206].
- core/openapi.ts wrap(): `bffKey: ra?.bffKind` (verifier result only; no header/body/query read added).
- Tests: pipeline/__tests__ 13 files, 202 passed, 24 skipped (pipeline.integration needs LIMS_TEST_DATABASE_URL). core+identity: 4952 passed, 1 failed (route-guard AppShell nav, pre-existing, out of scope).
- tsc: no errors in touched files (contracts/ and quality errors pre-existing).
- CR note: .orchestra/cr/AUTH-BFF-1.nonblocking.md (to C0 T0D-18).
- Open: web BFF side (LIMS_WEB_BFF_KEY on Vercel = Render lims-bff.key; LIMS_CORE_ENV=staging) is founder-only; DB-backed MEMBERS check unrun.
