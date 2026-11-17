# AG-T11 tests (tester)
Files (apps/bridge-agent/internal/config/): helpers_test.go (API contract in header), canonical_test.go, signed_test.go, apply_test.go, keys_test.go.
Covers AC-15.1 (bad sig / wrong agent / rollback / schema, keep current + report config_state, persists across restart, equal version = no-op), S-09, golden canonical vector.
Run: `cmd /c .orchestra\notes\AG-T11-verify.cmd` (= `go -C apps\bridge-agent test -count=1 ./internal/config/...`).
Now fails at build: `undefined: Applier` (no implementation yet) - correct reason.
LD-73 done: fixtures/config test-key.{pkcs8,spki}.pem + signature.b64url.txt regenerated (seed=SHA-256("cfg-test-1")), sha256 unchanged and verified, README updated, .gitignore negation `!services/api/.../fixtures/config/*.pem` added. Regenerator: .orchestra/notes/AG-T11-gen.cjs.
Writer: copy fixtures byte-identically to apps/bridge-agent/testdata/config; keys.go must NOT embed the test key. Confirm `git ls-files` lists both PEMs after commit.
