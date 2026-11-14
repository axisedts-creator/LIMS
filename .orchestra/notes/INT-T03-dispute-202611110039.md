# INT-T03 dispute (not a probe defect: stale tester-owned list)
- `__tests__/boot.test.ts` line 39 `IMPLEMENTED` is "tester-owned" (comment line 38) and must list every op whose stub a task replaced. INT-T03 wired 14 ops, so 14 boot tests now fail: "stub <op> throws common.internal".
- Add to `IMPLEMENTED`: submitHostQuery, listDrivers, listInstruments, createInstrument, getInstrument, updateInstrument, startInstrumentCommissioning, goLiveInstrument, suspendInstrument, resumeInstrument, retireInstrument, listObservedInstrumentCodes, getInstrumentSettings, updateInstrumentSettings.
- Wiring is required by the probes (they call the real handlers; 30 probes failed on the stubs). No probe is disputed. Writer cannot edit the test file.
- Unrelated pre-existing failure: `unit/signing.test.ts` "Go copy of the fixtures" (Go fixtures dir has README.md the TS dir lacks; AG-T11 owns it).
