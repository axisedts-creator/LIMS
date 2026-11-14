APPROVE

Scope: git diff b8b06093..HEAD (docs/manual/instruments/spikes.md new; tests/spikes/ag-t02.test.mjs revised per LD-93/LD-94; .orchestra notes).

- Figures: every verdict and figure in spikes.md traces to .orchestra/notes/AG-T02-evidence-win11.md (S1 PARTIAL incl. COM not tested; S2 codes 128/129/255 OK, 127 rejected, request.json 3.3 s vs 5 s; S3 0x800B0100 / 0 / 0x80096010 / 0x800B0109, publisher B rejected only by subject/thumbprint check). Nothing invented.
- LD-94 compliance: Win10 rows read NOT RUN + release gate (A36-4); no Server 2016 rows; three DECISION lines cite S1/S1/S2; Decisions section names TRD §5.12 and `install --account localservice`.
- Names verbatim vs 02-TRD §5.12 / 07-SECURITY: NT SERVICE\LimsBridgeAgent, C:\ProgramData\LIMS\BridgeAgent with six folders, ACL set, codes 128/129, status\request.json 5 s poll, REQ-SEC-116, REQ-SEC-119.
- Tests: change limited to LD-94 items (1)-(4); S1-S3, verdict format, DECISION and hygiene checks unchanged. `node --test tests/spikes/ag-t02.test.mjs`: 25/25 pass.
- Secrets/PHI: none. Thumbprints and key material kept out of the doc. Synthetic data only.
- Owned paths: only docs/manual/instruments/spikes.md and tests/spikes/ag-t02.test.mjs plus role notes.
- RLS/permissions/idempotency/rate tier/error codes: not applicable (doc-only spike).

Open (not defects, recorded in doc): Win10 run of S1-S3 (release gate), COM open, non-elevated control caller.
