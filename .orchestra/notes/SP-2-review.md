CHANGES
Re-review at 57d9122. No new commits since the last review; record, DECISIONS.md and CR refs (`.orchestra/cr/SP-2.nonblocking.md`) still correct (partial outcome, install command, queue_depth columns, residual privilege, no secrets/PHI). `node --test db/tests/spikes/SP-2.decision.test.mjs` 15/15 pass.

1. tests/spikes/SP-2.decision.test.mjs:1 — still tracked (`git ls-files tests/spikes` lists it); duplicate of db/tests/spikes/SP-2.decision.test.mjs under unowned root `tests/`. Fix: tester runs `git rm tests/spikes/SP-2.decision.test.mjs` and commits.

Out of SP-2 scope, for the lead: tests/spikes/ also still tracks SP-1, SP-3, SP-5, SP-8 decision tests; SP-1 is a duplicate of db/tests/spikes/SP-1.decision.test.mjs.
