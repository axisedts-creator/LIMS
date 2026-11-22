# T0D-FIX-6 debug
- Cause: writer fixed all sites (scan count = {}) but left fixtures/ctx-clock-baseline.json at 31 entries; 2 static tests (baseline holds no lab/frontdesk/micro key; baseline == tree) failed.
- Fix: baseline fixture set to {} (data file, no test edited). verify.cmd now 5 files / 67 tests green.
