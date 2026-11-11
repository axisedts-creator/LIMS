# AG-T16 impl
Files (apps/bridge-agent/): internal/update/{update,stage,launcher,authenticode_windows,authenticode_other}.go; cmd/launcher/{main,service_windows,service_other}.go. Tests: `go test -count=1 ./internal/update/... ./cmd/launcher/...` pass, vet ./... clean, no -race (CGO off).
[CONV] launcher pins versions\<v>\agent.exe to the SHA-256 of agent.exe inside the verified zip (not only Authenticode), so a swapped but validly signed older exe is refused.
[CONV] review 1: rollback() persists the failed version in root\rolled-back.json {versions:[...]} (launcher-only writer); Run() loads it; Download/Stage return *Error rolled_back without touching update-state.json for a listed version.
[CONV] review 2: root\download-attempts.json {version:[times]}; Download refuses a 4th attempt per version in 24 h (failed, "retry cap"); clock = package var update.Now.
[CONV] launcher applies pending.json only when not in probation; same-version pending = verify_failed; restart back-off 2 s; writeJSON retries rename (Windows open-file rename refusal).
Open: Policy is nil in cmd/launcher (downgrade never allowed); EmbeddedReleaseKeys empty (fail closed); Status.ErrorCode unset; agent launched with no args; Authenticode revocation off; signed-exe positive case not run (needs LIMS_AG_T16_SIGNED_EXE/_CN); rolled-back.json never pruned (a re-released fix needs a new version number).
