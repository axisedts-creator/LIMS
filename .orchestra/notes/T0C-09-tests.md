# T0C-09 tests (gate 10, A19.1/AB-25, CR-C3-008)
- File: `tools/codegen/__tests__/probe-manifest.test.ts` (fixture specs + throwaway repos built in tmp; no fixture files needed).
- Run: `cd tools/codegen && npx vitest run __tests__/probe-manifest.test.ts` (or `.orchestra/notes/T0C-09-verify.cmd`).
- Fails now: `tools/codegen/gen-probe-manifest.ts` missing; `.gitignore` lacks `tools/codegen/out/`.
- Contract fixed in the test header: `buildProbeManifest`, `probeTags`, `checkProbeCoverage`, CLI `--root <dir> [--check]`, output `tools/codegen/out/probe-manifest.json`.
- Covers: uncovered op fails gate; pending.json skip (malformed = fail closed); tags only from `__tests__/probes/`; device/staff_mobile boundary for non-`/v1/instruments/agent/` ops, `getQueueBoard` exempt from deviceToken only.
- Assumptions (spec silent): export names, manifest field names, `*_id`/`*_ids` heuristics, pending.json = JSON array of operationIds. Not tested: "pending empty at M6" enforcement; boundary probe on public (`security: []`) ops expecting 401/403 (spec ambiguous).
