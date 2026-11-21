# T0B-MSGDESK-1 dispute (debugger). Verify log: 2 reds, both tests contradict the spec/current repo; no implementation change can fix them.
1. partners/__tests__/contract/msgdesk1.pending.test.ts:28 requires pending ⊆ the 10 ticket ops. partners/index.ts:75 lists 15 pending SALES ops (T0C-SALES-1).
   LD-325(b): every T0C contract task adds its ids to the module pending list until its T0B handler task lands, so SALES ids legitimately stay pending. All 10 ticket ops are handled (pending has none of them).
   Fix in test: assert pending contains none of NEW_OPS (they are handled), drop the "only NEW_OPS may be pending" clause.
2. engagement/__tests__/boot.test.ts:95 expects PHASE_STUBS == ['QualityPort']. core/ports/phase-stubs.ts has [] since f2e98d271 (T-01); modules/quality/index.ts exists, so AC-0D-6.3
   (findStalePhaseStubs, phase-stubs.test.ts) forbids listing QualityPort. Re-adding it would break that gate. Fix in test: expect PHASE_STUBS toEqual([]) / not.toContain('EngagementPort').
Neither file is changed by T0B-MSGDESK-1 impl; both reds pre-exist (earlier ruling: out of scope). All 614 other static tests and the PG17 msgdesk suites pass.
