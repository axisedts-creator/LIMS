# T-28b impl (writer)
- Changed: `services/api/src/modules/catalog/ports/CatalogPort.impl.ts` only — `createCatalogPort` now returns `CatalogPortImpl` (adds `priceFor`).
- [CONV] priceFor validates (uuid ids, priority, ISO `at` with offset, context object) -> LimsError `common.validation_failed`, then delegates to `createQuoteService().quotePrices` (one rule set, 02-TRD §7.4-§7.6), maps snake -> camelCase, optionals omitted; per-item `error_code` thrown as LimsError.
- [CONV] No price cache and no revision read: every call is fresh in ctx.tx, so a revision bump is visible at once (<= 1 revision read satisfied trivially). Unknown extra query keys are ignored.
- Result: 84/85 pass (price suite + t28b self-check). 1 fail is a test defect: see `T-28b-dispute.md` (line 32 uses `credit_party_id`).
- Not run: full api suite / tsc / lint (stopped at dispute). Open: tester fix, then re-run `.orchestra\notes\T-28b-verify.cmd`.
