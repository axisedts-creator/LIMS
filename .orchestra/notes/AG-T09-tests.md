# AG-T09 tests (tester)
- File: `apps/bridge-agent/internal/drivers/registry_test.go` (package `drivers`; contract in header comment).
- Covers: 5 profile codes (3 generic + 2 Mindray sketches), TRD 5.2.4 ASTM defaults, HL7 ack defaults, sketch host-query types (`ORM^O01`, `QRY^Q02`), unknown driver_code -> protocol generic + `driver_profile_unknown`, hostile codes, unknown protocol, copy isolation, concurrency.
- Contract invented by tester (TRD 5.5 gives only `SessionProfile`): `ASTMTimers` field names, `Resolve(code, protocol) Resolution`, `Codes()`, `ProfileUnknownCode`. Unknown protocol -> zero Profile (assumption, not in spec).
- Run: `.orchestra\notes\AG-T09-verify.cmd` (= `go test -count=1 -race ./internal/drivers/...` in apps/bridge-agent).
- Expected now: fails to build (package has no non-test files / symbols undefined). `-race` needs cgo; drop it if no C compiler.
