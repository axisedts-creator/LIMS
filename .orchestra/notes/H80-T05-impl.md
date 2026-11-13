# H80-T05 impl (writer)
- Changed: NEW `db/migrations/20261113230000_instruments__add_truth_h80e_driver.sql` (CR-C7-019 approved by lead, LD-139: one g_drivers INSERT, generic, 0.1.0, no UPDATE/promotion); `e2e_main.go` (earlier: optional `instruments[].profile`).
- Sessions: `h80e-{oru-patient,api-down,q03-id-mismatch}.session.json` PID.5 "Test Patient" removed (synthetic-scan AC-21.4 flags any PID.5 name); oru-patient raw_sha256 -> 0eba7c5c… (new ORU bytes).
- [CONV] reply collector in e2e build is process-global (e2e tag only, never shipped).
- Result: vitest registry + ci-scripts + e2e 58/58 pass; `go test ./internal/simulator` ok.
- Open: pgTAP (`H80-T05.truth_h80e_driver.test.sql`, T0B-10) not run, no Postgres. Test sentinel 'Test Patient' (e2e line 33) now vacuous; tester may drop it. `internal/svc` TestStatusFileACLAppliedNoUsers fails (Windows ACL, unrelated, not touched).
