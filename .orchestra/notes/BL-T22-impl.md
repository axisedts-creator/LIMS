# BL-T22 impl (writer) — 2026-11-11
- Files changed: none. Per LD-105, implementation stays unchanged (fail-closed guards A6/A11, REQ-SEC-017/139). The tester's harness fixes to probe.kit.ts and the sample builder (60e3efc7) clear the 8 probe failures. Alert rule files and the CR (.orchestra/cr/BL-T22.nonblocking.md) were already in HEAD.
- Verify run (`pnpm --dir services/api exec vitest run src/modules/billing/__tests__/probes`): 5 files passed, 1 skipped; 359 tests passed, 7 skipped, 1 todo, 0 failed.
- [CONV] There is no billing probes/pending.json, so nothing needed removing (LD-70). createPaymentIntent/verifyPaymentIntent stay `notYet` (BL-T21, LD-98).
- Open: none for BL-T22. The tables.live suite is skipped (needs a live DB). The it.todo for PDF-with-JS is tracked as RG-5 (FD-T10 gap).
