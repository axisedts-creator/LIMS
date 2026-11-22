# T0D-BUILD-4 dispute (writer, 2026-11-22 15:0x NPT) — count pins only, not part of the tester's moved set
Tests: services/api/src/modules/analytics/__tests__/misreports/registry.static.test.ts:97 ("the contract still has its 30 operations") and
services/api/src/modules/analytics/__tests__/probes/coverage.probe.test.ts:64 (`expect(OPS.length).toBe(30)`).
Why wrong: the brief adds ONE operation (getMisReportPage); the tester already moved the same pin 30 -> 31 in boot.test.ts, contract.probe.test.ts, c8-openapi and misreports1-openapi (tests note). These two were missed.
Fix (tester): 30 -> 31 in both (count only). Everything else of the task is done and green; nothing else waits on this.
