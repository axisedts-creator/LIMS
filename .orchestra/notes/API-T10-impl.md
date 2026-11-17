# API-T10 impl (E05 submitHostQuery)
- File: services/api/src/modules/instruments/service/hostQuery.service.ts (impl from 2dd8a9bc; this pass: one `driverCtx()` helper replaces 2 bad `as DriverContext` casts, fixes tsc TS2352).
- Tests: `vitest run src/modules/instruments/__tests__/hostQuery` = 41/41 pass after tester fix b746c472 (no assertion changes needed).
- [CONV] Capability-gated query is archived + run `rejected_capability`, bytes never parsed; agent-key duplicate rebuilds reply from stored raw via `findMessageRaw`.
- [CONV] Re-query with identical bytes = new message, key kind `sha256_repeat` (§6.5).
- Open: instruments suite has 7 failures outside T10 (boot.test.ts handler-map stubs ×6, releases.service.test.ts E02 ×1); not caused by this file, not re-verified against HEAD.
- Open: handler wiring of `submitHostQuery` not tested (per tests note).
