# T-21 impl (C3 writer, after LD-61)
- Files: `services/worker/src/jobs/catalog/xlsx/{ZipInspector,XlsxReader,XlsxWriter}.ts`, `xlsx/templates/index.ts`; LD-61: `services/worker/{package.json,tsconfig.json}`, root `package.json` (worker:replay), `packages/shared-ts/package.json` ("./spreadsheet"), `pnpm-lock.yaml`.
- Result: T-21 suite 99/99 pass; full worker suite 754 pass, 10 skipped, 0 fail. graphile-worker@0.18.0 confirmed on npm. shared-ts built, subpath resolves.
- [CONV] LD-61: pins read-excel-file 9.3.14, write-excel-file 4.1.1 exact. [CONV] 50 MB = 50*1024*1024; row cap = rows.length > 20,000 per sheet; local headers must match central dir (extra hardening, untested by suite).
- Open: `pnpm install --frozen-lockfile` resolves the lockfile OK but exits non-zero on "Ignored build scripts: @scarf/scarf@1.4.0" (prism dep, not mine; needs `pnpm approve-builds` decision).
- Open: `pnpm --filter @lims/worker typecheck` = 15 TS2835/TS5097 errors, all in ../../contracts/ports and ../../packages/shared-ts/src (.ts imports under node16 resolution); none in worker src. Needs C0 owner decision.
- Open: timed-out parse keeps running (lib has no AbortSignal).
