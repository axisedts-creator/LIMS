## J-T01 debug round 1
- Cause: verify fails "No test files found" — dir services/api/src/modules/frontdesk/__tests__/integration/ does not exist. Tester commit 5f59c49f "J-T01 tests" only renamed .orchestra/cr/C3.T-31.md; no test files written.
- Not an implementation defect; no impl code change can fix it. Debugger may not author/edit tests. No fix applied.
- Next: re-route to TESTER to write FD integration tests (real BillingCommandPort, registration rollback proves counter rollback, US-FD-03.5). Deps FD-T06, BL-T07 should be confirmed done first.
