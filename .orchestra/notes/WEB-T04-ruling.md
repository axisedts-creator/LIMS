TESTS_WRONG — the tests put `flag_map` on the C3 wire as a JS object; the C3 contract types it as JSON object text (string ≤ 2000).
Reasons:
- contracts/openapi/catalog.yaml:11157-11160, 11203-11206, 11222-11225, 11274-11277: `InstrumentCodeMap`/`Create`/`Update`/`Row` `flag_map: type: string, maxLength: 2000`, "≤20 entries as JSON object text [CONV]". Examples at :7030, :7080, :7154, :7230 are `'{"H":"HIGH","L":"LOW"}'`.
- spec/chunks/C3-catalog-pricing/02-TRD.md:180 and 05-SCHEMA.md:1048 say "object" for the logical value / jsonb column only; the wire shape is the contract's text form ([CONV], 02-CONVENTIONS.md:12). No spec line requires an object on the wire, so the tests cannot assert one.
- spec/chunks/C7-instrument-integration/01-PRD.md:234 (AC-17.2): BFF calls C3 `createInstrumentCodeMap` with `flag_map?` — i.e. the C3 contract field as-is.
Change the tests:
1. web-t04.server.test.ts L165-170, L178-183, L244-255, L310: BFF input and the asserted outgoing C3 body carry `flag_map: JSON.stringify({...})` (forwarded unchanged).
2. L214-221: keep the same limit cases (21 entries, key > 16, value > 64, array, non-string value) but express each as `JSON.stringify(...)`; add string > 2000 chars and non-JSON text → `400 common.validation_failed` with no C3 call. Limits apply to the parsed form.
3. web-t04.components.test.tsx `cm()` L75 and `MAPROWS`: `flag_map` as JSON text; the component parses it for "Flag map count" (still 2, L181) and builds the string from `KeyValueListEditor` rows. `unset: ['flag_map']` unchanged.
