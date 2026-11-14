# T-28b impl (writer)
- Changed: `services/api/src/modules/catalog/ports/CatalogPort.impl.ts` only — `createCatalogPort` now returns `CatalogPortImpl` (adds `priceFor`).
- [CONV] priceFor validates (uuid ids, priority, ISO `at` with offset, context object) -> LimsError `common.validation_failed`, then delegates to `createQuoteService().quotePrices` (one rule set, 02-TRD §7.4-§7.6), maps snake -> camelCase, optionals omitted; per-item `error_code` thrown as LimsError.
- [CONV] No price cache and no revision read: every call is fresh in ctx.tx, so a revision bump is visible at once (<= 1 revision read satisfied trivially). Unknown extra query keys are ignored.
- Result after ruling (line 32 fixed): `T-28b-verify.cmd` 85/85 pass. tsc: no errors under `src/modules/catalog` (pre-existing TS2835/TS5097 in contracts/ports, packages/shared-ts).
- Catalog suite: 4886 pass, 7 fail — all `probes/pending.json` / skeleton stub-inventory tests (health, imports probes, skeleton); pending.json untouched by T-28b, failures pre-existing (stale pending.json, out of T-28b scope).
- Open: lint not run; pending.json staleness for owner of T-30/T-23 probes.
