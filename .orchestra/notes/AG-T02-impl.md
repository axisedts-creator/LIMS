# AG-T02 impl
- Files: docs/manual/instruments/spikes.md (new). No code.
- Figures copied only from .orchestra/notes/AG-T02-evidence-win11.md (LD-94). Win11: S1 PARTIAL, S2 PASS, S3 PASS. Win10 rows: NOT RUN, release gate (A36-4). No Server 2016 (LD-93).
- [CONV] One `##` section per spike with a per-OS table, then `## Decisions` holding the three DECISION: lines from LD-94 (account S1, DPAPI S1, control S2), with TRD §5.12 and `install --account localservice` named.
- Left out cert thumbprints and the raw evidence path (no long blobs in the doc).
- Tests: node --test tests/spikes/ag-t02.test.mjs gives 25/25 pass.
- Open: Windows 10 run of S1-S3 (pre-pilot release gate); COM open on a machine with a serial port; control from a non-elevated caller.
