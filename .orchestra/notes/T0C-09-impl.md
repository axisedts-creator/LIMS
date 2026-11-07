# T0C-09 impl
- Added `tools/codegen/gen-probe-manifest.ts` (buildProbeManifest, probeTags, checkProbeCoverage, CLI `--root`/`--check`); `.gitignore` += `tools/codegen/out/`.
- [CONV] Own small `$ref` resolver (`#/ptr` and `file.yaml#/ptr`, cycle-safe); lint-openapi has none cross-file.
- [CONV] bulkIdArrays requires `type: array`; bodyIdFields = top-level `id`/`*_id` of application/json body only.
- [CONV] Malformed pending.json -> exit 2 even without `--check` (fail closed); uncovered -> exit 1, stderr lists only uncovered ids.
- Tests: probe-manifest 20/20 pass; full codegen suite 210 pass / 3 skipped.
- Open: real repo `--check` fails today (getLiveness, getReadiness have no probes) — needs probe tests or pending.json from owning chunk before gate 10 is wired into CI.
