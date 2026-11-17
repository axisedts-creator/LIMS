# AG-T11 impl (writer)
Files: apps/bridge-agent/internal/config/{canonical,signed,apply,keys}.go; testdata/config/* (6 fixtures copied byte-identical from the API fixtures; no README).
canonical.go: own strict parser (dup keys, floats, lone surrogates, BOM, depth>64 rejected); signed.go: Verify order alg > key_id > Ed25519 over canonical(document) > agent_id > schema; undecodable envelope/document = signature_invalid.
apply.go: mutex + atomic temp/fsync/rename of the signed envelope (applied-config.json); reload re-verifies it. Lower version = rollback_rejected, equal = no-op, reject keeps current + sets Report().ConfigState.
[CONV] persisted file is the signed envelope, not the bare document, so a tampered file is ignored on restart.
Run: `go -C apps/bridge-agent test -count=1 ./...` = ok (config pkg 12s); go vet clean. gofmt and `git ls-files` PEM check not run (tool approval denied) - tester please confirm.
Review item 1 (LD-73 step 4): .gitignore now negates `*.pem` for the two fixture dirs; Go testdata PEMs copied byte-identical from API fixtures. `git add` / `git check-ignore` / gofmt were DENIED by tool approval, so the PEMs are NOT yet tracked - stage the 4 PEMs + .gitignore with a plain `git add` (no -f). Go tests: ok (1.8s).
Open: keys.go embeddedKeys is EMPTY (fail closed; no production key exists) - release pipeline must inject it. Deleting applied-config.json resets rollback counter (local-access attacker; ponytail comment in apply.go).
