TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Test packages/shared-ts/test/decimal.test.mjs:23-25 asserts every dependency matches /^\d+\.\d+\.\d+$/, including internal `workspace:*` links.
- spec/program/02-CONVENTIONS.md:13 [PIN-C0] requires C0 to pin an exact *version* (registry versions recorded in the lockfile and 02-TRD.md); a pnpm `workspace:*` link is not a version and is outside that rule.
- `"@lims/contracts": "workspace:*"` is required by LD-03 (T0A-08) for monorepo resolution; package.json is not a T0A-12 file, so the implementation cannot fix it.
- Binding LD-40 (2026-11-07, T0A-12) already rules this exact change.
Change: in the loop at decimal.test.mjs:24, skip entries whose value starts with `workspace:` (e.g. `if (v.startsWith('workspace:')) continue;`); keep the exact-pin assertion for all other deps, decimal lib included. Do not loosen the regex.
