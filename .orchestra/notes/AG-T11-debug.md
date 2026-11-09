Cause: API fixture PEMs (test-key.{pkcs8,spki}.pem) were missing from this worktree (never tracked; ignored until the .gitignore negation), so TestGoFixtureCopy_ByteIdenticalWhenPresent could not read the API side. No impl bug.
Fix: cp the tracked Go testdata PEMs (verified LD-73 key by the TestFixtures seed check) into the API fixtures dir, byte-identical. `go -C apps/bridge-agent test -count=1 ./internal/config/...` = ok.
Not done: `git add` of the 2 API PEMs needs tool approval - stage with plain git add (no -f), confirm `git ls-files '*config/*.pem'` lists 4.
Round 2: API fixture PEMs were absent again (untracked, so lost). Re-copied byte-identical from tracked Go testdata. go test ./internal/config/... = ok. No impl change.
Still needed: plain git add of the 2 API PEMs (blocked by tool approval); then git ls-files must list them so they persist.
Round 3: PEMs absent a 3rd time (untracked, lost). Re-copied byte-identical; go test ./internal/config/... = ok. No impl change.
STILL OPEN: `git add` denied again. Run: git add services/api/src/modules/instruments/__tests__/fixtures/config/test-key.pkcs8.pem services/api/src/modules/instruments/__tests__/fixtures/config/test-key.spki.pem (no -f); `git ls-files '*config/*.pem'` must list 4.
