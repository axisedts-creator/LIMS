TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)

Reasons:
1. spec/chunks/C7-instrument-integration/02-TRD.md:28: the Go toolchain is "pinned identically in `go.mod` (`go 1.26.x` + `toolchain go1.26.x`) and the CI image". "Identically" means go.mod and the CI image use the same version. It does not say the `go` line must equal the `toolchain` line.
2. spec/research/04-consolidated-decisions.md:32 (higher precedence, S16): "Toolchain Go ≥1.26 ... pin the toolchain in go.mod/CI consistently". It does not require go == toolchain either.
3. spec/program/02-CONVENTIONS.md:44 and :259 do require a `toolchain` line in go.mod, so the writer's first proposal (drop the toolchain assertion) is rejected.
Change the test at ag-t01.test.mjs:41-49 as follows:
- Keep both regexes and both `assert.ok(g)` and `assert.ok(t)`, so the `toolchain go1.26.x` line stays mandatory.
- Keep `Number(g[2]) >= 26` and add `Number(t[2]) >= 26`.
- Replace `assert.equal(t[1], g[1])` with: toolchain version >= go version (compare minor, then patch numerically). Rename the test "go >= 1.26 and toolchain line pinned (>= go directive)".
The implementation then uses `go 1.26.0` + `toolchain go1.26.10`. This survives tidy and matches the x/sys `go 1.26.0` floor in 04 S16. CI scripts must use go1.26.10, the same version as the toolchain line.
