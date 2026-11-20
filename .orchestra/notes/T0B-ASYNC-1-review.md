APPROVE
Scope: git diff 3beab7f11..HEAD (tester KNOWN-GAP revision f70e1e32b, arbiter ruling, impl notes). Only service file touched: services/worker/src/core/__tests__/async-manifests.test.ts (tester-owned per LD-279).
- done_when (3) as amended by LD-279: KNOWN_GAP holds exactly the seven ids, each reason carries CR-C0-T0B-ASYNC-1-001; exact-set assertion stops growth; "can only shrink" assertion fails when a listed id becomes loaded; unknown ids (not loaded, not listed) still fail.
- No names invented, no PHI, no secrets, no src/migration/policy/grant/render.yaml change in this range.
- Ran: `npx vitest run src/core/__tests__/async-manifests.test.ts` (services/worker) -> 17/17 pass.
- Not re-verified here: pgTAP grant test (no docker; lead runs it), live-DB suites.
