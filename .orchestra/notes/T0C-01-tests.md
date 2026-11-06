# T0C-01 tests (AC-0C-1.1)
- File: `contracts/__tests__/events.test.ts` (Vitest + `ajv/dist/2020`; reads IC §2.1/§2.2/§3.x/§3.25 directly, so schemas must equal the IC).
- Run: `pnpm vitest run contracts/__tests__/events.test.ts` (needs `ajv` 8.x in `contracts/package.json` deps, `vitest` from T0A-01).
- Fails now: `contracts/events/` and `contracts/package.json` missing. Implementer: files `contracts/events/<event_type>.schema.json` (+ `_defs.v1`, `_envelope.v1`), `$id` `urn:lims:event:<event_type>`, IC template verbatim; `$defs` must deep-equal the IC fenced defs.
- Covers: exactly 27 files / 25 events, IC §2 deep-equal, template, every IC example (incl. 3.26) validates, negative probes (extra/missing field, wrong type/producer/aggregate), `event_type` pattern good/bad, non-v7 ids, strictness (`additionalProperties:false`), no direct-identifier names.
- Verified only: IC extraction regexes parse all 25 events (node script). Tests NOT run (no node_modules/ajv in repo; sandbox denied a junction trial).
- Revised per ruling: Ajv `strictRequired:false` + `x-extensible` keyword registered; lax() skips if/then/else/not.
- Spec gap: 3.25 matrix lacks row #25 (jumps 24 → 26); I count 25 rows, treat as IC typo.
