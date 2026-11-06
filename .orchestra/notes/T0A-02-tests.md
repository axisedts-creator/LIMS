# T0A-02 tests
- File: tools/lint/tests/check-paths.test.mjs (owned path; node:test, no deps; spawns the CLI). Run: `node --test tools/lint/tests/check-paths.test.mjs`. Old copy tests/lint/check-paths.test.mjs must be deleted (unowned path).
- CLI contract (my choice; spec only gives `--branch`): `check-paths.ts --branch <ref> --files <list> --body <file>`; `--codeowners-out <file>` generates CODEOWNERS. Exit 0 pass, 1 gate fail, other nonzero = bad usage (fail closed). Header of test file documents it.
- Covers AC-0A-1.1/1.2/1.3 (owner+path in message, "contract change without CR reference", `Refs: CR-C<n>-<nnn>`), C0 sub-workstream branches, gaps, traversal/backslash/`./`, spoofed branch prefixes, malformed Refs, fail-closed inputs, CODEOWNERS header/coverage/determinism/no-drift/ordering.
- Expected now: 24 of 24 fail (check-paths.ts and .github/CODEOWNERS missing). Verified by run.
- Assumptions: CR-check scope = db/**, contracts/**, packages/**, **/core/** (TRD §15.1); CODEOWNERS handles per chunk not specified, test only requires distinct @handles per chunk. Not tested: real git diff / GitHub PR body fetch (workflow wiring is T0A-10).
