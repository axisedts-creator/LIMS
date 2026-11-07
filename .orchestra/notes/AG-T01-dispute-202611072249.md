# AG-T01 dispute
- Test: `ag-t01.test.mjs:41` "go >= 1.26 and toolchain pinned to the identical patch" requires a `toolchain go1.26.x` line equal to the `go 1.26.x` line.
- Conflict with Go 1.26.10: when `toolchain` == `go` version, `go mod tidy` removes the line and `go build` (readonly) fails with "go: updates to go.mod needed". Proven: with the line present, the windows/amd64 build test (:214) fails; without it, build passes and only this test fails.
- Both tests cannot pass at once. Pin is already exact via `go 1.26.10` (Go treats this as the minimum + toolchain).
- Proposed fix: drop the `toolchain` assertion (assert `go 1.26.x` with patch only), or use `go 1.26.0` + `toolchain go1.26.10` and compare toolchain >= 1.26.
- go.mod left in tidy state (no toolchain line). Tests untouched.
