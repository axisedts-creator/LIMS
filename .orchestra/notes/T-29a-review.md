APPROVE

T-29a review (reviewer) — diff a630aaf1..HEAD vs 02-TRD §6.1/§7.6a/§14 (27–30), 03-IC §4.2, 08 A2.2/A4.1/A5.6.
- Signature/names verbatim (`getTaxRate`, `catalog.tax_config_missing`, `kind 'vat'|'other'`, VAT `effectiveFrom: null`, `^[A-Z0-9_]{1,16}$`). Malformed input mapped to tax_config_missing per §6.1 [CONV].
- Reads only `catalog.g_tax_types` / `catalog.cs_tax_types` on ctx.tx, binds only, tenant from ctx.tenantId; windows [from,to) via existing `taxTypeVersionAt`; no writes, no logs, no secrets; owned paths only.
- Ran: real CatalogPort.taxRate.test.ts 29/29 pass; fake run-contracts -t CatalogPort 32/32 pass.
- Non-blocking notes: (a) §7.6a tail says "reads the same cached tax-type rate versions as priceFor (§6.3)" — impl is uncached (one indexed read); result is still deterministic per revision, so no behavioural defect. (b) Timezone fixed to Asia/Kathmandu instead of IdentityPort.getTenantSettings — acceptable because v1 accepts only that zone (08 A13 P-15); revisit when other zones are allowed. (c) Shared contract not yet wired to the real port (T-29).
