TESTS_WRONG — services/api/src/modules/analytics/__tests__/boot.test.ts:246: raise the AN-T01 timeout `30_000` -> `60_000`; keep both assertions (n === 30, unmounted === []) unchanged. Also raise any other case in that file that boots the real repo with a 30000 budget to 60000 (:265 already 60_000).

Reasons:
1. LD-375 (2026-11-18 12:25 NPT, binding, overrides spec text for this task): ruling TESTS_WRONG on exactly this case, time budget only; "Do not dispute the timeout again; it is the last open item."
2. No spec line fixes a boot-test time budget; the asserted behaviour (all 30 analytics operations mounted, AC-0D-1.2 handlers == operationIds) passes — only wall time fails.
3. The time is core per-route ajv compile (core/openapi.ts:115) across all 17 modules, not analytics code (dispute.md:7); the sibling full-repo boot test already allows 60_000 (src/__tests__/real-modules-boot.test.ts:22).
4. Nothing is loosened: same assertions, same mount check; only the timeout changes.
5. WRITER/DEBUGGER: change no analytics code and do not touch core/openapi.ts for this (a lazy/cached ajv compile needs its own task and CR, LD-375).
