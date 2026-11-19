# SEC-AUTHZ-4 debugger
- Cause: tests/security/authz-classification.json is stale (total 1018, last committed at SEC-AUTHZ-2; 159 operations of other modules added since). It was never regenerated after the SEC-AUTHZ-4 code. 3 of 8 node tests fail on it; the 5 fresh-classifier tests pass (identity unguarded 0).
- Implementation is correct: fresh classifier total 1177, identity unguarded 0, no exception rows needed. vitest part of verify.cmd was already green (779/779).
- Fix: none in code. The snapshot is tester-owned (debugger cannot keep a change to it). Tester must run `node tests/security/classify-authz.mjs > tests/security/authz-classification.json` and the lane commits it. See SEC-AUTHZ-4-dispute.md.
