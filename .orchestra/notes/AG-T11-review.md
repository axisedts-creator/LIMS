CHANGES
1. .gitignore:10 (`*.pem`) — LD-73 step 4 not done. No negation exists despite AG-T11-tests.md claiming one was added; `git status --ignored` shows all four PEMs ignored and `git ls-files` lists none of them:
   services/api/src/modules/instruments/__tests__/fixtures/config/test-key.{pkcs8,spki}.pem and apps/bridge-agent/testdata/config/test-key.{pkcs8,spki}.pem.
   Go tests pass locally only because the untracked files are on disk. On a clean checkout, helpers_test.go:80/89 (`pemBlock`) and canonical_test.go:42-69 fail, and the TS API-T08 vector tests fail the same way (the LD-73 regression again).
   Fix: after line 10 add
     !services/api/src/modules/instruments/__tests__/fixtures/config/*.pem
     !apps/bridge-agent/testdata/config/*.pem
   Then run plain `git add` on the four PEMs (no -f), check that `git check-ignore` matches none of them and `git ls-files '*config/*.pem'` lists all 4, and commit.

Checked OK: config_state values match 05-SCHEMA agent_status__config_state__ck verbatim; schema `lims.bridge.config.v1` and envelope fields match 02-TRD 5.10; Verify is fail-closed (signature checked before any document field is read); rollback/equal/no-op handling in apply.go is under the mutex; persist is atomic; keys.go embeds no test key; only owned paths plus testdata copy; `go test ./internal/config/...` = ok (17.5s, local only, because of item 1). RLS/permissions/idempotency/rate tier: not applicable (agent-side Go). No PHI or secrets (synthetic test key only).
