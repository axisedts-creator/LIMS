## SEC-AUTHZ-5 debugger (2026-11-19)
- Cause: only 2 node tests fail (authz-classification "classifier output equals the committed snapshot"; authz-identity "snapshot equals a fresh classifier run"). Committed tests/security/authz-classification.json is stale: 87 catalog ops still `unguarded`, fresh classifier run says `guarded-exact` (writer guards work; fresh-run checks pass).
- Fix: none in implementation code (it is correct). Needs TESTER to regenerate the snapshot (`node tests/security/classify-authz.mjs > tests/security/authz-classification.json`) and the lane to commit it; debugger/writer cannot keep a change to it. Not a spec dispute.
## SEC-AUTHZ-5 debugger round 2 (2026-11-19)
- Same cause, re-confirmed: 5 node tests fail (authz-classification x2 snapshot-vs-fresh, authz-identity x1, authz-catalog x2 "0 unguarded" on committed snapshot). Snapshot tests/security/authz-classification.json is stale; implementation correct, no code change.
- Needs TESTER: node tests/security/classify-authz.mjs > tests/security/authz-classification.json, lane commits it. Not a spec dispute.
