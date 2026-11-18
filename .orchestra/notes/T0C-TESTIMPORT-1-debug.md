# T0C-TESTIMPORT-1 debug
- Cause: stale pin in testmgmt1-openapi.test.ts:562; T0B-TESTMGMT-1 removed those ids from pendingOperations per LD-325(b). Not a TESTIMPORT-1 regression.
- Fix: none in implementation code (would violate LD-325(b)). Dispute written to T0C-TESTIMPORT-1-dispute.md. Stopped.
