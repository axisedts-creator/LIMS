TESTS_WRONG — the "<= 4 statements" budget is a test-local number the spec never sets; the contract adds one constant tenant-scoped price read, so the budget becomes 5 (dispute 2).
Reasons:
1. contracts/openapi/catalog.yaml:10485-10489 puts default_price_paisa on OrderableSummary, which searchOrderables returns (spec/chunks/C3-catalog-pricing/02-TRD.md:194). The search must read the default price list, so it needs one more statement. tests.defaultprice.test.ts:50 is right and stays as written.
2. The spec sets only latency for this read: 02-TRD.md:756 (searchOrderables p95 <= 150 ms) and 02-TRD.md:749 (catalog size). No spec line gives a statement count. The "4" was a proxy for "no per-row lookups" (orderables.search.test.ts:209; perf test header lines 6-8).
3. Change for the TESTER (writer does not edit tests, LD-443/LD-445):
   a. orderables.search.test.ts:209/214: change toBeLessThanOrEqual(4) to toBeLessThanOrEqual(5). Update the title to "at most 5 statements for a full page (one tenant-scoped default-price read; no per-row lookups for department code / panel kind / price)".
   b. perf/orderables.search.perf.test.ts:51: change toBeLessThanOrEqual(4) to toBeLessThanOrEqual(5). Keep line 52 (constant count) and the p95 checks unchanged.
4. What the budget protects is unchanged. Line 52 and the 30-row page with a limit of 20 still catch a per-row price lookup (N+1). The p95 bound in 02-TRD.md:756 still applies.
5. Implementation unchanged. The ruling-1 rule still holds: the fakes answer the price statement, and the implementation and other assertions stay as they are.
