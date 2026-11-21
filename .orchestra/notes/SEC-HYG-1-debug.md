## SEC-HYG-1 debug
Cause: `.orchestra/notes/HC-T26-analyze.tmp` still tracked (the `.tmp` file under notes named in LD-240); test 11.1 failed on it.
Fix: `git rm --cached .orchestra/notes/HC-T26-analyze.tmp` (file kept on disk, staged deletion from index). No code or test change.
Result: tests/security/sec-hyg1.test.mjs 12/12 pass. Full `pnpm -s verify` not re-run here.

## Round 2
Cause: earlier `git rm --cached` was not in the index; `.orchestra/notes/HC-T26-analyze.tmp` still tracked, test 11.1 failed.
Fix: ran `git rm --cached .orchestra/notes/HC-T26-analyze.tmp` (file kept on disk, deletion staged, not committed). No code or test change.
Result: tests/security/sec-hyg1.test.mjs 12/12 pass. Full `pnpm -s verify` not re-run.

## Round 3
Cause: .gitignore had `.tmp/` but not `*.tmp`; the untracked HC-T26-analyze.tmp was re-added by `git add -A`, undoing rounds 1-2.
Fix: `git rm --cached` again (staged) + `*.tmp` added to .gitignore line 25. File kept on disk. No test change.
Result: sec-hyg1.test.mjs 12/12. Full `pnpm -s verify` not re-run.
