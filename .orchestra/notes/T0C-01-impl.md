# T0C-01 impl (AC-0C-1.1)
- Files: `contracts/package.json` (@lims/contracts; ajv 8.17.1, yaml 2.8.1, vitest 3.2.4); `contracts/events/` 27 files (`_defs.v1`, `_envelope.v1`, 25 events incl. `instruments.calibration.received.v1`), generated verbatim from IC §2/§3, `$id` `urn:lims:event:<event_type>`.
- No schema changes after ruling (T0C-01-ruling.md); tests revised by tester, schemas unchanged.
- Run: `cd contracts && npx vitest run` → 2 files, 187/187 pass (events 173, registry-equality 14).
- [CONV] Added `"type":"object"` to template `allOf[1]` and its `aggregate` (Ajv strictTypes requires it; envelope already types both, semantics unchanged).
- Open: IC §3.25 matrix skips row #25 (24 → 26); 25 rows counted, treated as IC typo (tester note too). Candidate CR for spec owner.
