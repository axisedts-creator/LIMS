# SEC-AUTHZ-3 tests (tester)
- New: services/api/src/core/pipeline/__tests__/authz-central.platform.test.ts (34 contract-scanned platform.* ops x enforce/shadow/roles/aal; actor kinds; modes; no-PII; support-session rule; bffSession untouched). Reuses authz-central-rig.ts; no new interface pinned.
- Edited (SEC-AUTHZ-2 file authz-central.test.ts, 2 tests): they pinned "platform.* is skipped", which SEC-AUTHZ-3 reverses; now an allowed platform actor passes, and the stage-9 "skipped" sample is an op with no x-permission.
- Run: `.orchestra/notes/SEC-AUTHZ-3-verify.cmd` (also re-runs SEC-AUTHZ-2 suites, stage09, platform-ctx/wire-ctx, authz-guard, classifier test).
- Must fail now: tenant/patient/system/device actors and platform_support/aal1 reach the handler on platform ops (stage skips platform.*); stage 9 500 for passed platform ops without handler assertion.
- Snapshot tests/security/authz-classification.json: class platform must stay 34; regenerate with classify-authz.mjs after the writer's commit, lane commits it (no change expected).
- Not covered: per-handler guard vs x-permission (no mismatch seen in the five platform services, so no CR); real DB/RLS unchanged.
