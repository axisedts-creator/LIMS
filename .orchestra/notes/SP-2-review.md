APPROVE
Re-review at b39d516 (diff 3b054a7..HEAD: notes only, plus SP-2-verify.cmd). Prior item 1 resolved: tests/spikes/SP-2.decision.test.mjs removed in 3abaaf5 per LD-18; `git ls-files tests/spikes` no longer lists SP-1/SP-2. Only copy is db/tests/spikes/SP-2.decision.test.mjs.
db/meta/decisions/SP-2.md and services/worker/src/core/DECISIONS.md unchanged since last review (partial outcome, install command, queue_depth columns, residual privilege, CR refs, no secrets/PHI). `node --test db/tests/spikes/SP-2.decision.test.mjs` 15/15 pass.

Out of SP-2 scope, for the lead: tests/spikes/ still tracks SP-3, SP-5, SP-8, SP-9 decision tests under unowned root `tests/`.
