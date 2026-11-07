# AG-T02 impl — BLOCKED (no change)
- Files changed: none. `docs/manual/instruments/spikes.md` NOT written.
- Reason: ruling (AG-T02-ruling.md) requires measured S1/S2/S3 results from Win10/11/Server 2016 VMs; none exist in repo. Writing verdicts without runs = fabricated evidence (ruling line 8).
- Tests: `node --test tests/spikes/ag-t02.test.mjs` fails ENOENT on spikes.md (expected until results arrive).
- Open: human runs S1–S3 on 3 VMs, supplies PASS/FAIL/PARTIAL + one-line evidence per OS per spike; writer then fills doc + 3 DECISION: lines (account / DPAPI scope / control path).
- Downstream AG-T04, AG-T15 stay blocked.
