# T0A-02 debug
- Cause: verify cmd `pnpm -s verify` failed with "Command "verify" not found": root package.json had no `verify` script. Not a code/test defect.
- Fix: added root script `verify` = `turbo run build typecheck && node --test tools/lint/tests/*.test.mjs tests/lint/*.test.mjs` (excludes T0-03 pins test, out of scope).
- Result: `pnpm -s verify` passes (turbo build+typecheck, 45/45 tests incl. check-paths 24/24).
