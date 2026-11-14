# MET-T05 impl (writer)
- Files: `apps/web/src/features/instruments/components/InstrumentForm.tsx` only (preset option "Getein Metis series", lab-PC wording, §3 code suggestions, nine-step §9 checklist + runbook line). No test files touched.
- [CONV] Preset reuses the H80E mechanics (LD-163, D-MET-3): hl7v2 + tcp_server, driver getein_metis, vendor Getein / model Metis, `lanPreset` shares the lab-PC labels. Bind/port/peer validation from forms/transport.ts (0.0.0.0 refused).
- [CONV] Host-query toggle gate unchanged: driver capability host_query AND status = verified, so disabled with reason while getein_metis is generic (LD-163, LD-139).
- [CONV] Code suggestions are the addendum's example ids only (U2); nothing seeded, C3 owns code-map rows.
- Checks: met-t05 vitest 38/38; h80-t06 vitest 31/31 (H80E unchanged). Playwright/axe e2e NOT run (needs stack); tsc/lint not run this session.
- OPEN: options_schema field still pending CR H80-T06 (shared with H80E).
