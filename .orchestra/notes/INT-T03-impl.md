# INT-T03 impl
- New `services/api/src/modules/instruments/handlers/instruments.handlers.ts`: E05 submitHostQuery, E22-E32, E40, E41 mapped to the existing services (path `instrument_id`, snake_case query/body, `If-Match "<n>"`, ETag on single-object answers). Edited `handlers/index.ts` to merge them.
- Probes: `vitest run src/modules/instruments/__tests__/probes` = 138/138 pass. Whole `src/modules/instruments`: 1722 pass, 15 fail (14 boot stub-list, 1 signing Go fixtures; see INT-T03-dispute.md).
- [CONV] handler shape copied from agents.handlers.ts (bind + ifMatch + etag); host query copied from device.handlers.ts (no ETag, service headers passed through).
- Open: config publisher is still `unwiredPublisher` in E26-E31/E41 handlers, so any change that must publish a config version answers common.internal in production until the publisher is injected (no publisher exists in C7 yet). Probes do not publish.
- Open: boot.test.ts `IMPLEMENTED` needs the 14 ids (tester-owned). tsc not run clean for whole api (known unrelated import errors); no errors reported in handlers/.
