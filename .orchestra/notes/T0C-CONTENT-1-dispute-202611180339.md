# T0C-CONTENT-1 dispute (debugger, 2026-11-18)
Verify fails only at services/api/src/modules/engagement/__tests__/boot.test.ts:95 ("PHASE_STUBS no longer lists EngagementPort and still lists QualityPort"): `expect([...PHASE_STUBS]).toEqual(['QualityPort'])`, received `[]`.
Spec: services/api/src/core/ports/phase-stubs.ts line 1 (02-TRD stubs paragraph, 08 R9, AC-0D-6.3): "Remove a port here in the same PR that ships its owner module." T-01 (f2e98d271) shipped modules/quality/index.ts and emptied PHASE_STUBS; the sibling test 'AC-0D-6.3 gate' in the same file passes with the empty list.
T0C-CONTENT-1 touches no port or phase-stubs file. Re-adding QualityPort would break AC-0D-6.3. Fix needed (tester/lead): change line 95 to expect [] (or drop the QualityPort clause). I may not edit tests.
