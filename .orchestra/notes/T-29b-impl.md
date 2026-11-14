# T-29b impl (writer) — CatalogPort.getPriceListStatus (08 A24.1, 02-TRD §7.4a)
- Files: `ports/CatalogPort.impl.ts` (method + `CatalogPortImpl` Pick), `domain/priceMatch.ts` (pure `listStatus`).
- [CONV] Uncached: 2 bind-only reads on ctx.tx (price_lists by tenant+id, price_list_versions statuses) — TRD says "cached index", but uncached keeps version changes visible at once (test requires); cache later if hot.
- Malformed id -> `common.validation_failed` (allowed by tests); unknown/foreign id -> `common.not_found` (no status disclosed).
- Zero-version / superseded-only list reads `discarded` (spec silent, unreachable via V5).
- Run: real 25/25 pass, fake CatalogPort contract 32/32 pass. tsc: only pre-existing contracts/shared-ts import errors; none in changed files.
