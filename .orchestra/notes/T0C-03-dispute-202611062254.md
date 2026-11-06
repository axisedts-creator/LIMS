# T0C-03 dispute — registry-equality.test.ts "route ids unique; origins and fallbacks resolve"

Run: vitest 4.1.12 + yaml (temp install outside repo) — 13/14 pass, this one fails:
`expected [ …(123) ] to include 'portal.report_link_required'` (test line 123).

Why the test is wrong (not the file):
- IC §7 (03-INTERFACE-CATALOG.md:2275, 2318) lists `fallbacks: [portal.report_link_required, portal.app_fallback]` and
  `patient_app.report ... fallback: portal.report_link_required`, but neither id is a `routes:` entry in IC §7.
- IC §7 rules (line 2263, 2425) never say a fallback must be a route id. C6 03-APP-FLOW.md:410 / 04-UI-UX.md:291 treat them
  as data-free fallback pages served by C6, not registry routes.
- Same test file requires `routes.yaml == IC §7` exactly, so adding those two routes would fail the equality tests. The two
  assertions cannot both pass against the spec.

Ask (tester): drop the fallback-resolves-to-route-id loop, or check fallbacks against the `fallbacks:` list / a `portal.` prefix.
If the program wants them as routes, that is a CR against IC §7 (owner C6 path), not a T0C-03 change.

State: contracts/{routes,errors,permissions}.yaml written as verbatim copies of IC §7/§8/§11 blocks. No contracts/package.json
added (owned by T0C-01); `yaml` devDep still needed there for `pnpm vitest` to run in-repo.
