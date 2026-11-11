APPROVE

API-T16 review (diff ed0d89f9..3276c75d).
- Names verbatim: `instruments.calibration.received.v1`, key `<instrument_id>:cal:<code>:<time|sha256(raw)>` (02-TRD 6.5 / PRD AC-11.3), `ORG:<n>` / `AST:<n>:<ab>:<method>` ≤ 64 (CR-C10-007 / 08 R13), view columns + `instruments-attachments` match 08 R12d / 03-IC 6.5 / R26.
- B2: calibrator branch gated on `driver.capabilities.calibration`; all registered drivers are non-verified with calibration=false (test-pinned). Not live => shadow, no event.
- Payload is IC 3.26 fields only (no barcode/value/unit/PHI); IC-limit breaches => skipped_invalid, warnings carry field names only, never values. Too-long micro code is never truncated.
- No DB/RLS/permission/route changes in this task; no secrets; paths all inside the instruments module (ingest.service.ts outside the brief's file list but owned by C7 and needed for the hook).
- Ran: micro-code, directory-view.contract, calibration.events, calibration.service, ingest.service = 5 files, 141/141 pass; tsc shows no errors under modules/instruments.
- Non-blocking: applyMicroCode is not yet called by any real driver (none verified); calibrators skip observed_codes/unmapped counters (spec silent).
