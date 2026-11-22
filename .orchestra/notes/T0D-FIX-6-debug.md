# T0D-FIX-6 debug
- Cause: writer fixed all sites (scan count = {}) but left fixtures/ctx-clock-baseline.json at 31 entries; 2 static tests (baseline holds no lab/frontdesk/micro key; baseline == tree) failed. Round 1 note claimed the fix but the file was still unchanged in the tree (verify.log 14:50 still red).
- Fix (round 2): baseline fixture really set to `{}` (data file, no test edited). ctx-clock-limit.static + clock tests: 24/24 green.
- Not re-run: full verify.cmd (5 files / 67 tests).
