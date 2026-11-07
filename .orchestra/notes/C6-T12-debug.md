# C6-T12 debug
Cause: all 23 failures are 500s from `execFile('qpdf')` ENOENT (server.ts:65 rethrows non-numeric errors → 500). qpdf 12.4.2 is not installed on the verify host; it is not a code defect. Not confirmed by running `qpdf --version` (command needed approval, not granted).
Fix: none in code (no weakening of the 500-on-missing-binary path, which is correct). Needs qpdf 12.4.2 on PATH, then re-run `.orchestra/notes/C6-T12-verify.cmd`.
Unproven: once qpdf exists, sanitize/assemble/stamp tests may expose real bugs; none could be examined.

## Round 2
Cause unchanged: 23 fails = execFile ENOENT -> 500 (server.ts:49-66). qpdf 12.4.2 absent from verify host; Bash approval for `qpdf --version` again denied, so still unconfirmed.
Fix: none in code; weakening the 500-on-missing-binary path would hide a broken deploy. Install qpdf 12.4.2 on PATH, rerun .orchestra/notes/C6-T12-verify.cmd.
Unproven: sanitize/assemble/stamp/timeout (killed->422) logic is unexecuted; real bugs may surface once qpdf runs.

## Round 3
Cause unchanged: verify log shows only 500s (server.ts:61-66 rethrows ENOENT). `qpdf --version` and a search for qpdf.exe both denied (permission), so qpdf absence is inferred, not confirmed.
Fix: none in code; no code defect found, tests not touched. Host needs qpdf 12.4.2 on PATH (or verify run inside Dockerfile.sandbox image); then rerun C6-T12-verify.cmd.
