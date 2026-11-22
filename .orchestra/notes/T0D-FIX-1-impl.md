# T0D-FIX-1 impl (writer)
Files: core/openapi.ts (csvQueryParams + splitCsvQuery, preValidation hook per route in mountSpec); inventory/handlers/alerts.schemas.ts (status string or array);
micro/service/chain.service.ts (clockOf: new Date(ctx.now()), NaN -> common.internal); smartreport/handlers/summaries.ts + reporting/handlers/reports-read.handlers.ts (numeric limit);
lab/service/worklist.service.ts (now = new Date(c.now()), store still gets a Date); catalog/repo/tests.repo.ts defaultPrices (1 statement, tenant_id = $1 on all 3 tables) + tests.service.ts testExtras.
[CONV] split only `in: query`, `explode: false`, `type: array` params (local $ref resolved); empty elements kept so the schema rejects them; repeated + comma forms flattened.
[CONV] default price = version of the owner_kind 'default' list in force at ctx.now (published, or superseded whose window holds now), same rule as getPriceListDetail current_version.
[CONV] ChainCtx.now type left as () => Date (widening it breaks culture.service.ts, not owned); clockOf normalises at runtime.
Checks (after ruling, e41ed0d85): new tests + catalog integration/perf/unit = 3851 pass, 3 fail; tsc clean. BLOCKED: search statement budget 4 vs price on search (tests conflict), see T0D-FIX-1-dispute.md.
Open: other explode:false handlers (instruments, payments, engagement, reporting display_status, inventory movement_kind) already received arrays via coerceTypes 'array'; not re-tested per handler. Ratchet sites: see T0D-FIX-1-left.md.
