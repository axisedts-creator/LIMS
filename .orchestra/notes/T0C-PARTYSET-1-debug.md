# T0C-PARTYSET-1 debug (2026-11-18)
- Log: codegen step green (6 files, 1492 tests), then "The system cannot find the path specified." with no output from the contracts/api/db steps. That is a cmd path/launcher error, not a test failure.
- Re-ran each verify step by hand on lane/C0-0M HEAD: contracts registry-equality 5 passed; services/api 14 files, 665 passed; db suite T0C-PARTYSET-1_party_settings PASS. No implementation defect found.
- Cause not reproducible from code. Suspect: step 2 `cd /d "%~dp0..\..\contracts"` or the quoted Git bash.exe path failed in the verify runner's environment. No code or test edited.
- Next: re-run verify; if the same error repeats, inspect the runner's cwd/%~dp0 and the bash.exe path, not the implementation.
