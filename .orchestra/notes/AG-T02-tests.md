# AG-T02 tests
- File: `tests/spikes/ag-t02.test.mjs` (node:test, no deps). Run: `.orchestra\notes\AG-T02-verify.cmd`.
- Checks deliverable `docs/manual/instruments/spikes.md`: S1 (virtual account + COM + DPAPI user/machine scope), S2 (control codes 128/129 + request.json fallback), S3 (WinVerifyTrustEx on test-signed exe: unsigned/tampered/untrusted root, publisher check), `## Decisions`.
- Doc contract: each spike `##` section has one line per OS (Windows 10 / Windows 11 / Server 2016) with PASS|FAIL|PARTIAL; `## Decisions` has `DECISION:` lines (account, DPAPI scope, control path) each citing S1/S2/S3; no TODO/TBD/UNVERIFIED; no secrets.
- Fails now: doc missing. VM runs are manual; tests only prove results were written down.
- Not tested: truth of the recorded results; the scripted spike harness.
