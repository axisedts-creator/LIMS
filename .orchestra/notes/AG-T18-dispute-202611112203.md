# AG-T18 dispute: test file package clause cannot compile next to `package main`

`apps/bridge-agent/build/release/release_test.go` line 1 is `package release_test`. The tool must be `package main` (tests run `go build .` and execute the result). Go refuses to load a directory holding `package main` plus `package release_test`:

    found packages main (main.go) and release (release_test.go) in ...\build\release

(`go vet` / `go test` both fail with it, so no test can run.) A non-main package would build, but not to a runnable exe.

Fix (tester): change line 1 to `package main_test` — the only valid external-test name for a `package main` dir. Nothing else in the test needs to change; it only uses exec + update imports.

Writer state: `apps/bridge-agent/build/release/main.go` is written (package main, stdlib only) and covers the header contract; not yet run because of the above. Re-run `.orchestra\notes\AG-T18-verify.cmd` after the fix.
