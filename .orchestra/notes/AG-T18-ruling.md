TESTS_WRONG — change line 1 of `apps/bridge-agent/build/release/release_test.go` from `package release_test` to `package main_test`; change nothing else.

Reasons:
- spec/chunks/C7-instrument-integration/06-IMPLEMENTATION-PLAN.md:42 (AG-T18) asks for release pipeline scripts under `build/*` that produce a verifiable package + seed. It says nothing about Go package names, so the clause `release_test` is not something the spec requires.
- The test needs a runnable tool: release_test.go:114-121 runs `go build -o release.exe .` in the test dir and then executes it (release_test.go:208). Only `package main` builds to an executable, so the writer's `main.go:7 package main` is what the test itself needs.
- Go only allows a directory to hold package P plus external test package `P_test`. For P=`main`, that means `main_test`. `release_test` next to `main` fails to load ("found packages main ... and release ..."), so no test in the file can run.
- The fix renames only the package. All assertions stay as they are: the test works through exec and imported packages, never main's unexported identifiers.
- After the tester fixes the test, the writer reruns `.orchestra/notes/AG-T18-verify.cmd`. The implementation is not yet proven to pass.
