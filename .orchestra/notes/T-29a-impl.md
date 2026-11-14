# C3 T-29a impl (writer) — getTaxRate
- `domain/tax.ts`: + `isTaxCode`, `localMidnight(on)` (real YYYY-MM-DD only -> Asia/Kathmandu 00:00 instant). Reuses `taxTypeVersionAt` / `isTaxTypeUsable`.
- `ports/CatalogPort.impl.ts`: + `getTaxRate` (type `CatalogPortImpl` now picks `getTaxRate`). VAT -> `g_tax_types WHERE code=$1 AND is_active=$2`, `effectiveFrom: null`; else `cs_tax_types WHERE tenant_id=$1 AND code=$2`, window picked in memory, `effectiveFrom` = ISO UTC.
- [CONV] any malformed input / unknown / inactive / NULL rate -> `catalog.tax_config_missing` (TRD §6.1, §7.6a step 1). Tenant timezone fixed at Asia/Kathmandu (factory has no identity dep; P-15 v1 accepts only it).
- Uncached on purpose (one indexed read), same as mapInstrumentCode.
- Run: real taxRate 29/29 pass; fake contract (CatalogPort) 32/32 pass. Full catalog suite: 7 fail, all in skeleton.test.ts / health.handlers.test.ts (pending.json lists + autoloader timeout), none touch getTaxRate.
- Open: shared contract not wired to real port (T-29); pending.json stale entries are not mine to edit; services/api `tsc --noEmit` shows only pre-existing contracts/ import-extension errors, none in my files.
