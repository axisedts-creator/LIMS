# H80-T02 tests (truth_h80e server driver, LD-139)
- NEW `services/api/src/modules/instruments/__tests__/unit/drivers-truth-h80e.test.ts`: registry entry, optionsSchema, M1/M3 parse, tolerant time (OBX-12..14), malformed/other, fuzz, PHI-ignore, existence + content of writer goldens in `drivers/truth_h80e/testdata/` (oru-patient, oru-qc, oru-chromatogram, malformed-no-msh).
- EDITED `__tests__/unit/drivers-registry.test.ts`: seed now six rows (+truth_h80e), manualRef allowed only for truth_h80e (was "none"; addendum §0/§8 gives it a manual).
- Also run: existing `drivers-golden.test.ts` auto-executes the writer's testdata (*.raw -> *.expected.json). Run all: `.orchestra/notes/H80-T02-verify.cmd` (pnpm --dir services/api exec vitest run ...).
- Writer must keep PID-5 EMPTY in testdata (ci-scripts REAL-repo synthetic-scan has no allowlist; "Test Patient" there fails it). PHI-ignore is proven by inline cases instead.
- SEAM: QC `controlLevel` = qc_level_map[OBR-5], default L->"low", unmapped letter passes through raw. Host query (QRY/QCK/DSR) = H80-T03; inline attachment payload = H80-T04, neither asserted.
- KNOWN COUPLING (not mine): `ci-scripts.test.ts` "REAL repo: shipped drivers and db/migrations agree" will fail once truth_h80e is registered until the H80-T05 g_drivers migration lands. Lead must sequence T05 or accept that one red test.
