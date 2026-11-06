# T0A-01 impl
- Files: package.json, pnpm-workspace.yaml, pnpm-lock.yaml, turbo.json, tsconfig.base.json, eslint.config.js, .prettierrc, .nvmrc, .gitleaks.toml, .gitignore (+*.tsbuildinfo, .dart_tool/), pubspec.yaml, analysis_options.yaml, packages/{shared-ts,test-fixtures}/{package.json,tsconfig.json,src/index.ts}, packages/shared-dart/{pubspec.yaml,lib/lims_shared.dart}.
- [CONV] Provisional pins (latest on registry 2026-11-07): pnpm 12.18.0, node 26.13.0, turbo 2.11.10, typescript 7.0.2; T0-03 confirms + fills TRD §2.3.
- [CONV] Empty packages build via `tsc -p tsconfig.json` to dist/ (gitignored); typecheck = `tsc --noEmit`; Dart workspace root `lims_workspace`, sdk ^3.6.0.
- Tests: 10/11 pass incl. build smoke. Test 10 (lockfile tracked) passes once files are committed; `git add`/commit was not approved in this session.
- Open: local Node is 25.8.0 (pnpm did not enforce engines); Turbo telemetry phones home (set TURBO_TELEMETRY_DISABLED=1 in CI, T0A CI task); Dart `pub get` not run.
