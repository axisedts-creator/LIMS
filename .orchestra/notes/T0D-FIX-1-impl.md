# T0D-FIX-1 impl (writer)
Files: core/openapi.ts (csvQueryParams + splitCsvQuery, preValidation hook per route in mountSpec); inventory/handlers/alerts.schemas.ts (status string or array);
micro/service/chain.service.ts (clockOf: new Date(ctx.now()), NaN -> common.internal); smartreport/handlers/summaries.ts + reporting/handlers/reports-read.handlers.ts (numeric limit);
lab/service/worklist.service.ts (now = new Date(c.now()), store still gets a Date); catalog/repo/tests.repo.ts defaultPrices (1 statement, tenant_id = $1 on all 3 tables) + tests.service.ts testExtras.
[CONV] split only `in: query`, `explode: false`, `type: array` params (local $ref resolved); empty elements kept so the schema rejects them; repeated + comma forms flattened.
[CONV] default price = version of the owner_kind 'default' list in force at ctx.now (published, or superseded whose window holds now), same rule as getPriceListDetail current_version.
[CONV] ChainCtx.now type left as () => Date (widening it breaks culture.service.ts, not owned); clockOf normalises at runtime.
Checks (after ruling 2, be7f6fc53): verify set + all of catalog = 6111 pass, 0 fail; 24 catalog files need LIMS_TEST_APP_URL (DB, not run here); tsc clean; eslint has no config for services/api. Implementation unchanged since 354a2f017.
Open: other explode:false handlers (instruments, payments, engagement, reporting display_status, inventory movement_kind) already received arrays via coerceTypes 'array'; not re-tested per handler. Ratchet sites: see T0D-FIX-1-left.md.
