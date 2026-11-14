# H80-T06 impl (writer)
- Files: `components/InstrumentForm.tsx` (preset Select, lab-PC labels/text, options form from schema, §3 code suggestions, §9 nine-step checklist, host-query gate), `server/types.ts` (`Driver.options_schema?`).
- [CONV] Host query is enabled only when driver capability host_query AND status = verified (02-TRD §6.6 step 2, LD-139); reason text names generic/commissioning/verified. Applies to every non-verified driver, not only H80E.
- [CONV] Parser options: create mode only, string/enum schema props only, own keys only (`__proto__`/`constructor`/`prototype` skipped), sent as `parser_options` = changed keys only.
- [CONV] Bind/port/peer validation reused from forms/transport.ts (0.0.0.0, 127.x, non-IPv4, port <1024 refused). Preset never seeds code-map rows.
- OPEN: contract `Driver` has no options schema: CR needed for `options_schema` (tester flagged the same).
- OPEN: vitest could NOT run (2 runs, "Failed to start forks worker ... Timeout waiting for worker to respond", 0 tests; same host error as LD-166). Tests unverified; tsc started, result not read. Not run: web-t03/rs-c7 regression suites (host-query gate may affect web-t03 expectations on generic drivers with host_query).
