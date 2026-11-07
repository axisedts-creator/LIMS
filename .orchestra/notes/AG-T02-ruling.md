IMPLEMENTATION_WRONG — the test is right; the implementation must deliver `docs/manual/instruments/spikes.md` with measured S1/S2/S3 results on Win10/11/Server 2016 and three DECISION: lines. Blocked until a human runs the spikes on the VMs.
- Dispute does not challenge any assertion; it reports the writer cannot run VMs. That is an environment blocker, not a test or spec defect.
- Plan row requires spike "on Windows 10, 11, Server 2016 VMs" with "written results; fallbacks chosen (LocalService / machine-scope DPAPI / request.json)": spec/chunks/C7-instrument-integration/06-IMPLEMENTATION-PLAN.md:26. Tests check exactly per-OS verdicts + 3 decisions.
- S1 checks (virtual account, COM, DPAPI user scope, CRYPTPROTECT_LOCAL_MACHINE fallback) trace to 02-TRD.md:351, 02-TRD.md:450, 06-PLAN:126 (R4), 07-SECURITY.md:29 (REQ-SEC-116).
- S2 checks (codes 128/129, x/sys/windows/svc, status\request.json 5 s poll) trace to 02-TRD.md:456.
- S3 checks (WinVerifyTrustEx, test-signed exe, publisher check) trace to 06-PLAN:26 and 07-SECURITY.md:32 (REQ-SEC-119); negative cases are the minimal proof a publisher check works.
- Spec not contradictory or missing, so no CR.
- Writer was right to refuse: writing verdicts without runs is fabricated evidence. Do not fill the doc with placeholders to pass the tests.
- Next step: a human runs S1–S3 on the 3 VMs and supplies verdict + one-line evidence per OS per spike; the writer then fills the doc and the DECISION: lines (cite S1/S2/S3 and TRD §5.12 / `install --account localservice`).
- Downstream AG-T04 and AG-T15 depend on AG-T02 (06-PLAN:28, :39); they stay blocked on these decisions.
