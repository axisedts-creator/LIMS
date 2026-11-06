TESTS_WRONG — the test asserts something the spec does not require
Change in contracts/__tests__/registry-equality.test.ts, test "route ids unique; origins and fallbacks resolve" (lines 122-124):
replace `expect(ids).toContain(fb)` loop with: every per-route `r.fallback` must be a member of `f.fallbacks`
(and `f.fallbacks` entries are unique). Keep the route-id uniqueness and origin-resolution assertions unchanged.
Reasons:
- spec/program/03-INTERFACE-CATALOG.md:2275 defines `fallbacks:` as a separate top-level list, not as `routes:` entries.
- 03-INTERFACE-CATALOG.md:2276-2418: no route with id `portal.report_link_required` or `portal.app_fallback` exists.
- 03-INTERFACE-CATALOG.md:2318, 2413: per-route `fallback:` values are exactly the ids in the `fallbacks:` list (2275).
- 03-INTERFACE-CATALOG.md:2263, 2425 (§7 rules): no rule requires a fallback to be a route id.
- Same test file line 114 requires routes.yaml to equal IC §7 exactly, so adding those ids as routes is not allowed; the
  current assertion can never pass against a spec-conformant file.
