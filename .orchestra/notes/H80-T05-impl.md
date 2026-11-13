# H80-T05 impl (writer)
- Changed: `apps/bridge-agent/cmd/agent/e2e_main.go` (optional `instruments[].profile`: drivers.Resolve profile -> mllp HostQuery -> hostquery.Relay -> E05; host query committed as queue kind `host_query`; no API answer = nothing written, AC-10.6). Registry entry + 5 `h80e-*` session files already existed.
- NOT done: the g_drivers migration. `db/` is C0-0B only (01-CHUNK-MAP §3), so I filed `.orchestra/cr/H80-T05.md` (CR-C7-019, exact INSERT, status generic, no UPDATE). 3 registry tests stay red until C0 lands it.
- [CONV] reply collector is a process-global (test build answers one query at a time); never shipped (e2e tag).
- Result: e2e 5/5 now pass (was 5 fail); registry 3 fail (missing row only); `go vet -tags e2e` clean.
- Open: `ci-scripts.test.ts` REAL-repo case and pgTAP stay red/unrun until the migration exists.
