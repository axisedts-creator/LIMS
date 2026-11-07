# AG-T02 blocked (not a test defect)
- Deliverable `docs/manual/instruments/spikes.md` must hold measured PASS|FAIL|PARTIAL per spike (S1 virtual account/COM/DPAPI, S2 control codes 128/129, S3 WinVerifyTrustEx) on Windows 10, Windows 11, Server 2016.
- Writer session has no VMs, no admin approval for host probing (PowerShell probe was denied), no Go toolchain (see AG-T01). Results cannot be measured here.
- Writing verdicts or `DECISION:` lines without runs would be fabricated evidence; tests only check text exists, so they would pass falsely. Not done.
- Needed: human runs the three spikes on the 3 VMs, supplies raw results (verdict + one-line evidence per OS per spike); writer then fills the doc and the 3 `DECISION:` lines (account, DPAPI scope, control path) citing S1/S2/S3.
- Fallbacks to pick from (06-PLAN R4): LocalService / machine-scope DPAPI (CRYPTPROTECT_LOCAL_MACHINE) / `status\request.json` 5 s poll.
