## Debugger T0B-DBSEED-1
- Cause: committed db/tests/fixtures/probe-rows/*.sql (18 files) were stale vs generator output (working tree was CRLF, generator emits LF; --check and determinism test compare bytes). No generator bug.
- Fix: reran `node db/tools/gen-isolation-probes.ts` (regenerated fixtures, LF). `--check` ok; T0B-DBSEED-1 test 30/30. No test edited.
- Risk: if a checkout re-converts to CRLF (autocrlf), staleness returns; needs `.gitattributes` eol=lf for db/tests/fixtures (not my path).
