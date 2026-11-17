# API-T10 tests (E05 submitHostQuery)
- Files (services/api/src/modules/instruments/__tests__/): `hostQuery.service.test.ts` (AC-10.1–10.4, 10.7, security), `hostQuery.perf.test.ts` (AC-10.5), `hostQuery.helpers.ts` (fakes + SEAMS header).
- Run: `.orchestra\notes\API-T10-verify.cmd` = `pnpm --dir services/api exec vitest run src/modules/instruments/__tests__/hostQuery`.
- Seam: `createHostQueryService({ repo, getDriver }).submitHostQuery(ctx, { body })` in `service/hostQuery.service.ts`; reuses T09 `IngestRepo` + new `findMessageRaw(tx, tenantId, messageId)` (reply rebuild on agent-key duplicate).
- ctx needs `ports.LabPort`, `ports.CatalogPort` (outbound), `commitOnError()`; thrown LimsError codes asserted (capability_not_supported, instrument_unknown, device_mismatch, message_malformed, driver_not_available).
- Idempotency-Key requirement checked against contracts/openapi/instruments.yaml only (core replays before service).
- Unspecified, not tested: sha256 mismatch on E05, 0-test found specimen, handler wiring of `submitHostQuery`.
