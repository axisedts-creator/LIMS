# INT-T03 impl
- New `services/api/src/modules/instruments/handlers/instruments.handlers.ts`: E05 submitHostQuery, E22-E32, E40, E41 mapped to the existing services (path `instrument_id`, snake_case query/body, `If-Match "<n>"`, ETag on single-object answers). Edited `handlers/index.ts` to merge them.
- Probes: `vitest run src/modules/instruments/__tests__/probes` = 138/138 pass. Whole `src/modules/instruments` after ruling: 1722 pass, 1 fail (unit/signing.test.ts Go-fixture README.md mismatch; outside INT-T03 per ruling, API-T08/AG-T11).
- [CONV] handler shape copied from agents.handlers.ts (bind + ifMatch + etag); host query copied from device.handlers.ts (no ETag, service headers passed through).
- Open: config publisher is still `unwiredPublisher` in E26-E31/E41 handlers, so any change that must publish a config version answers common.internal in production until the publisher is injected (no publisher exists in C7 yet). Probes do not publish.
- boot.test.ts `IMPLEMENTED` updated by tester per ruling; boot now green. tsc not run clean for whole api (known unrelated import errors); no errors reported in handlers/.
