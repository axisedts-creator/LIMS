# T0C-02 debug
- Cause: verify log = `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL … Command "verify" not found`. Task row has `verify:"pnpm -s verify"` (run.ps1:123) run at repo root; root `package.json` scripts have only `build`,`typecheck`. No `verify` script exists anywhere. Not an impl/test fault: `vitest run` in contracts/ = 250/250 (incl. tsc --noEmit) per impl note.
- Fix NOT applied: root `package.json` is not a C0-0C path (owned by T0A-01/T0-03). Needs owner to add root `"verify"` script (e.g. `turbo run test` / `pnpm -r test`) or set T0C-02 `verify` to `pnpm -C contracts test`.
- Stray: ruling asks TS version recorded in C0 02-TRD (spec/ read-only) — still open for spec owner.
