# T0A-02 impl (writer)
- Files: tools/lint/check-paths.ts, .github/CODEOWNERS (generated from tools/lint/ownership.yaml; committed in 0fd0296). No change needed after ruling.
- Result: `node --test tests/lint/check-paths.test.mjs` 24/24 pass (incl. revised fail-closed test + unknown flag). ownership.test.mjs passes.
- [CONV] Fail closed: exit 0 pass, 1 gate fail, 2 bad usage/unreadable input/unsupported glob in ownership.yaml.
- [CONV] Owner resolution = most specific pattern (longest literal prefix, then longest pattern); CODEOWNERS emitted general-first so last-match-wins agrees.
- [CONV] CR ref = line `Refs: CR-C<n>-<nnn>[, CR-...]` anywhere in body (CRLF ok); contract scope db/**, contracts/**, packages/**, **/core/** (TRD §15.1).
- Open: tsc typecheck of check-paths.ts not run (permission denied in session). tests/monorepo/T0-03.pins.test.mjs has 8 failures — T0-03 scope, not this task. Workflow wiring = T0A-10.
