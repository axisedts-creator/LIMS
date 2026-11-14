# SP-1 tests
- File: db/tests/spikes/SP-1.decision.test.mjs (node:test, no deps; repo has no JS framework yet)
- Run: `node --test db/tests/spikes/SP-1.decision.test.mjs`
- Checks db/meta/decisions/SP-1.md: outcome, image digest + evidence, session_id/aal (aal1->aal2) or C2 T1 blocker, LIMS_CORE_JWT_ALG value, iss/aud/exp, stable across refresh, no hook/claimsResolver, no raw JWT/keys.
- Expected now: all 8 fail ("SP-1.md must exist"). Live GoTrue behaviour can't be unit-tested; record evidence checked structurally only.
