APPROVE

Note: `git diff 06efea38..HEAD` is empty (HEAD == 06efea38; AG-T09 commits 99adc99e, b4c0e433, 9819f656 are already in base). Reviewed those commits / current `apps/bridge-agent/internal/drivers/*` instead.

- Names verbatim: `SessionProfile` fields match TRD 5.5; codes `astm_generic_e1394`, `hl7v2_generic_oru`, `file_drop_generic`, `mindray_bc5380_sketch`, `mindray_bs200_sketch` match TRD §4/§6.3; `driver_profile_unknown` matches TRD 5.5.
- ASTM defaults match TRD 5.2.4 table exactly (15/10/20/1/15/30/15/60 s, 6/6/3, latin1).
- Sketch host-query types `ORM^O01` / `QRY^Q02` match TRD §6.3 table.
- done_when "unknown profile fallback reported": unknown driver_code -> protocol generic + `HeartbeatError=driver_profile_unknown`; covered by TestUnknownDriverCodeFallsBackToProtocolGenericAndIsReported and edge-input/unknown-protocol tests.
- Deep copies prevent registry mutation (tested, incl. concurrency).
- No DB/RLS/permissions/routes in scope (pure agent profiles, no I/O). No logging, no PHI, no secrets. Only owned paths + orchestra notes.
- Checks run: `go vet ./internal/drivers/` clean; `go test -count=1 ./internal/drivers/` ok. `-race` not run (CGO disabled in env).
