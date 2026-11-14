# BL-T20 debug
- Cause: env, not impl. screens.test.tsx fails to resolve `@testing-library/react`: apps/web/package.json has no test devDeps (msw, jsdom, axe-core, @testing-library/*). Static suite 18/18 pass; impl note says 54/54 pass with temp aliasing config.
- Fix: none in impl code. Deps belong to C0-0D via CR-C7-WEB-T02-a (01-CHUNK-MAP §3; not my path); already referenced in .orchestra/cr/BL-T20.nonblocking.md item 4. Tests not edited; not a spec dispute.
- Unblock: C0-0D lands CR-C7-WEB-T02-a (+ lockfile, `pnpm install --frozen-lockfile`), then re-run BL-T20-verify.cmd. Needs lead decision to treat as blocking or run verify with aliased config.
- Round 2: re-checked. Same failure (`@testing-library/react` unresolved); apps/web/package.json on lane and main still lacks test devDeps. No impl fix possible, no test edit. Still blocked on CR-C7-WEB-T02-a / lead decision.
- Round 3: re-checked. Same failure; main (3391f06c) and lane apps/web/package.json still lack @testing-library/*, msw, jsdom, axe-core. No impl fix possible, no test edit. Blocked on CR-C7-WEB-T02-a / lead decision.
