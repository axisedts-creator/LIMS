# T0B-OPSDOC-1 debugger
- Cause: all 7 health-env failures = response validation. `Readiness` in contracts/openapi/core.yaml:65 is closed (additionalProperties:false, no `missing_env`), so health.ts's `missing_env` body is rejected -> 500 common.internal; the 7th is the static pin on core.yaml. Docs/scan tests pass; the old `_`-strip test bug was already fixed per ruling.
- Fix: none possible in this lane. The one needed change (optional `missing_env` array, pattern ^LIMS_[A-Z0-9_]*[A-Z0-9]$) is in contracts/, owned by C0-0C only (01-CHUNK-MAP.md:108). health.ts is correct; dropping the field or bypassing response validation would break done_when (3).
- Action: CR already filed (.orchestra/cr/T0B-OPSDOC-1.md, CR-C0-T0B-OPSDOC-1-001). Needs C0-0C to merge it, or a lead LD authorising this lane to edit core.yaml. Re-run health-env.test.ts after.

## Round 2
- Verify log (20:14) still shows the same 7 health-env failures; cause unchanged: `Readiness` in contracts/openapi/core.yaml is closed and has no `missing_env`, so response validation rejects the health body.
- Fix: none in this lane (contracts/ is C0-0C ONLY, 01-CHUNK-MAP.md:108). Blocked on CR-C0-T0B-OPSDOC-1-001 (.orchestra/cr/T0B-OPSDOC-1.md). No code changed; no test touched.
