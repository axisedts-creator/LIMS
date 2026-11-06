# T0A-02 impl (writer)
- Files: tools/lint/check-paths.ts, .github/CODEOWNERS (generated from tools/lint/ownership.yaml), package.json (review item 2: `verify` no longer globs unowned `tests/lint/*.test.mjs`).
- Result: `node --test "tools/lint/tests/*.test.mjs"` 35/35 pass (check-paths 24/24 + monorepo-skeleton). Gate run on this task's own files (CODEOWNERS, package.json, check-paths.ts, tools/lint/tests/check-paths.test.mjs) exits 0.
- [CONV] Fail closed: exit 0 pass, 1 gate fail, 2 bad usage/unreadable input/unsupported glob in ownership.yaml.
- [CONV] Owner resolution = most specific pattern (longest literal prefix, then longest pattern); CODEOWNERS emitted general-first so last-match-wins agrees.
- [CONV] CR ref = line `Refs: CR-C<n>-<nnn>[, CR-...]` anywhere in body (CRLF ok); contract scope db/**, contracts/**, packages/**, **/core/** (TRD §15.1).
- Open: tsc of check-paths.ts not run (no @types/node in repo). tests/lint/ownership.test.mjs still in unowned root `tests/` (T0-02 tester's file, not this task) — now outside `verify`. Workflow wiring = T0A-10.
