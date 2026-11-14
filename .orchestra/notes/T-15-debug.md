# T-15 debug
Cause: test contradiction, not an implementation bug. Only failure: `test_no_literal_hosts_ips_or_secrets_and_cites_decisions` (l.536) forbids any IPv4 literal; `test_job_psql_wrapper_forces_tcp_loopback` (l.562-565) requires `-e PGHOST=127.0.0.1` in psql.j2. No code passes both.
Fix: none in implementation (would break the other test / review item 1). Existing `.orchestra/notes/T-15-dispute.md` confirmed; loopback is not a LD-45 host address; proposed fix: l.536 strips `127.0.0.1` before the regex.
Stopped for tester/lead ruling. 62/63 pass.
Round 2 (re-run of verify cmd): same single failure, test l.536 vs l.562-565 (psql.j2 `PGHOST=127.0.0.1`, 62/63). `out/T-15-verify.log` is stale (yamllint/gitleaks of T-01 files), not T-15. No impl change; dispute stands, awaiting tester/lead ruling.
Round 3: re-confirmed from fresh `out/T-15-verify.log` (63 tests, 1 failure, l.536 matched `127.0.0.1` in psql.j2). Test l.565 requires that literal; l.536 forbids it. No impl change; dispute `T-15-dispute.md` stands.
Round 4: re-read verify log + test. Same single failure: l.536 (no IPv4 literal) vs l.565 (requires `PGHOST=127.0.0.1` in psql.j2). Unsatisfiable together; no impl change. Dispute `T-15-dispute.md` stands, needs tester/lead ruling (proposed l.536 fix: strip 127.0.0.1 first).
