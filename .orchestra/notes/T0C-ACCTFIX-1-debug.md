# T0C-ACCTFIX-1 debug
- Verify: 1092 pass, 1 fail: acct1-openapi.test.ts:534 (migration order pin). acctfix1, lint-openapi, c4 green.
- Cause: stale test pin. Main now has later migrations (20261117140000 frontdesk, 20261117170000 catalog); test allows only 20261117130000.
- No impl change made: yaml change correct; only "fix" would be touching other tasks' migrations (out of scope).
- Dispute written: notes/T0C-ACCTFIX-1-dispute.md. Tester must widen the pin.
