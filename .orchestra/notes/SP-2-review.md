CHANGES
Re-review of 4998f01 + 190f993. Fix 2 done: all three CR refs now `.orchestra/cr/SP-2.nonblocking.md` (SP-2.md:4,85; DECISIONS.md:7). New db/tests/spikes/SP-2.decision.test.mjs: paths correct, `node --test db/tests/spikes/SP-2.decision.test.mjs` 15/15 pass. Record content unchanged and still fine (partial, install command, queue_depth columns, residual privilege, no secrets/PHI).

1. tests/spikes/SP-2.decision.test.mjs:1 — fix 1 only half done: the tester copied the file instead of moving it, so the old copy is still tracked under unowned root `tests/` (`git ls-files tests/spikes` lists it). Fix: tester runs `git rm tests/spikes/SP-2.decision.test.mjs` and commits. Both SP-2 notes already say this is open.

Out of SP-2 scope, for the lead: tests/spikes/SP-1.decision.test.mjs is also still tracked next to db/tests/spikes/SP-1.decision.test.mjs (same copy-not-move problem).
