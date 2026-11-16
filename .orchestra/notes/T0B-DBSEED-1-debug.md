## Debugger T0B-DBSEED-1
- Cause: committed db/tests/fixtures/probe-rows/*.sql (18 files) were stale vs generator output (working tree was CRLF, generator emits LF; --check and determinism test compare bytes). No generator bug.
- Fix: reran `node db/tools/gen-isolation-probes.ts` (regenerated fixtures, LF). `--check` ok; T0B-DBSEED-1 test 30/30. No test edited.
- Risk: if a checkout re-converts to CRLF (autocrlf), staleness returns; needs `.gitattributes` eol=lf for db/tests/fixtures (not my path).
## Debugger T0B-DBSEED-1 round 2
- Cause: worktree files re-converted to CRLF (index LF, autocrlf) so generator --check compared raw bytes and flagged all 18 fixtures stale; fixes of round 1 (regen) did not survive checkout.
- Fix: gen-isolation-probes.ts --check now normalizes CRLF to LF for probe and fixture files; regenerated (LF). --check ok, T0B-DBSEED-1 test 30/30. No test edited.
- Risk: determinism test hashes raw committed bytes; on a CRLF worktree it still fails. Durable fix = .gitattributes eol=lf for db/tests/** (not my path).
