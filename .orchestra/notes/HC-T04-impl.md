# HC-T04 impl (writer)
- Files: `settings.service.ts` (H18/H19/H20 logic + validation), `mappers/settings.mapper.ts`, `handlers/{getHomecollectionSettings,updateHomecollectionSettings,listHomecollectionReasons}.ts`; `index.ts` wires the 3 ops.
- Order: assertRole -> If-Match (428/400) -> body validation (400) -> version check (409) -> lazy create (`insertSettingsIfAbsent`, ON CONFLICT DO NOTHING; re-read on lost race) -> `updateSettings` (null = 409).
- [CONV] GET with no row returns TRD §11.2 defaults at version 1 and does NOT persist; PUT with no row validates and checks If-Match "1" first, so a failed PUT creates no row.
- [CONV] Validation is hand-written in the service (the tests call handlers directly): contract ranges, D-128 six seed codes, D-129 notify_patient=true -> 400, second_identifier=birth_date -> 400 (until CR-C17-003), unknown fields -> 400. Duplicate payment codes allowed (spec silent).
- Ran: static.test.ts 6/6 pass; `tsc --noEmit` clean for homecollection. NOT run: settings.test.ts / reasons.test.ts (need PG17 via docker; "Docker Desktop is unable to start").
- Rerun after ruling (no code change): boot.test.ts + static.test.ts 45/45 pass (26-of-26 mount test passed, no timeout); tsc 0 homecollection errors. Still NOT run: settings/reasons DB suites (no Docker/PG17 on this host).
