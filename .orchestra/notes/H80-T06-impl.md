# H80-T06 impl (writer)
- Files: `components/InstrumentForm.tsx` (preset Select, lab-PC labels/text, options form from schema, §3 code suggestions, §9 nine-step checklist, host-query gate). `server/types.ts` back to baseline (review 1, rs-c7 LD-140).
- [CONV] Host query enabled only when driver capability host_query AND status = verified (02-TRD §6.6 step 2, LD-139); applies to every non-verified driver.
- [CONV] Parser options: create mode only, own keys only (`__proto__`/`constructor`/`prototype` skipped), changed keys only. String props = TextField (maxLength from schema, else 64 per 04-UI-UX §3) or Select; numeric enum (type absent/integer/number) = Select, sent as number (review 2).
- [CONV] Schema read through one accessor `driverOptionsSchema()` (local `options_schema`), pending `.orchestra/cr/H80-T06.md` (E22 Driver has no optionsSchema; real app shows no options until CR lands).
- [CONV] Bind/port/peer validation reused from forms/transport.ts (0.0.0.0 refused). Preset never seeds code-map rows.
- Checks: vitest h80-t06 31/31, rs-c7 35/35, web-t03 98/98; tsc clean for instruments non-test files. Playwright/axe e2e not run (needs stack).
- OPEN: CR H80-T06 (field name + rs-c7 baseline for server/**).
