# T0-02 tests
- File: tests/lint/ownership.test.mjs (node:test, no deps)
- Run: `node --test tests/lint/ownership.test.mjs`
- Reads tools/lint/ownership.yaml. Format (test parses this subset; impl must match): `rules:` list of `- pattern: "<glob>"` + `owner: <C\d+|C0-0A..D|DOC-OWNER>`. Glob: `**`, `*`, `{a,b}`, `<m>`, trailing `/`.
- Resolution: most specific rule wins (longest literal prefix, then longest pattern); equal-specificity different owners = overlap fail. Duplicate patterns and catch-alls fail.
- Checks a reference path list (CM §3 + TRD §1.1: 0A/0B/0C/0D, C1-C18 modules, route groups, renderer templates, docs) for gap, overlap, and correct owner; AC-0A-1.1 (c05/x -> billing -> C4) and AC-0A-1.2 (lab passes).
- Expected now: 9 of 10 fail with "tools/lint/ownership.yaml must exist"; matcher self-check passes (verified by run).
- Assumption: doc owner token `DOC-OWNER` and `<m>`-style module expansion are my choices; spec gives no file schema. Not testable here: CODEOWNERS generation and check-paths.ts (T0A-02).
