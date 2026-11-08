Cause: API fixture PEMs (test-key.{pkcs8,spki}.pem) were missing from this worktree (never tracked; ignored until the .gitignore negation), so TestGoFixtureCopy_ByteIdenticalWhenPresent could not read the API side. No impl bug.
Fix: cp the tracked Go testdata PEMs (verified LD-73 key by the TestFixtures seed check) into the API fixtures dir, byte-identical. `go -C apps/bridge-agent test -count=1 ./internal/config/...` = ok.
Not done: `git add` of the 2 API PEMs needs tool approval - stage with plain git add (no -f), confirm `git ls-files '*config/*.pem'` lists 4.
