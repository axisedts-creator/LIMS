# T0C-06 tests (AC-0C-2.2)
- Files: `tools/codegen/__tests__/oasdiff.test.ts` + fixtures `tools/codegen/__tests__/fixtures/oasdiff/{base,head-breaking,head-compatible}.yaml`.
- Run: `cd tools/codegen && npx vitest run __tests__/oasdiff.test.ts` (needs bash; stub `oasdiff` on PATH, real-oasdiff block auto-skips if not installed).
- Fails now: `tools/codegen/oasdiff.sh` does not exist.
- Contract fixed: `oasdiff.sh <base> <head>` runs `oasdiff breaking <base> <head> --fail-on ERR`; env `PR_LABELS` (comma/newline/space list, exact token) with `cr-approved-breaking` bypasses oasdiff exit 1 only; exit >1 / missing binary / bad args (exit 2) fail closed.
- Assumptions (spec silent): label delivery via `PR_LABELS`; oasdiff exit 1 = breaking, >1 = tool error. 0A job must set `PR_LABELS` from the PR labels.
- NOT run: real oasdiff not installed here, so real-fixture tests (breaking fixture really detected) were not exercised.
