TESTS_WRONG — test asserts something the spec does not require
Test: packages/shared-ts/test/decimal.test.mjs:23-25 "package.json: every dependency is an exact pin" matches every dep against /^\d+\.\d+\.\d+$/.
Fails on `"@lims/contracts": "workspace:*"` (packages/shared-ts/package.json, added by T0A-08; apps/web uses the same for @lims/ui).
Why wrong: spec/program/02-CONVENTIONS.md:13 ([PIN-C0]) requires exact pins of external *versions*. `workspace:*` is a pnpm workspace link, not a registry range; it cannot match a semver literal and cannot be changed without breaking monorepo resolution. package.json is not a T0A-12 file, so no implementation fix is possible.
Proposed test fix (tester): skip values starting with `workspace:` in the loop (still assert all other deps are exact pins, incl. the decimal lib).
