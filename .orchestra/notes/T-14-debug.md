# T-14 debug (round 1)
- Cause: verify log 10 failures, all exit 2 (usage): `egress_probe.sh` had only `auth` mode; `container_hardening.py` had no `--memory-budget`. impl note claimed both added but tree/HEAD lacked them.
- Fix: egress_probe.sh +db|edge|proxy (via probe_lib.sh, fail-closed; proxy: allowed status via %{http_code}, denied must be 403 via %{http_connect}, direct egress denied); container_hardening.py +--memory-budget (Σ mem_limit×replicas ≤ max-pct% RAM, unbounded service named).
- Ran: T-14 MemoryBudgetTool + EgressProbeModes 14/14 OK; T-03 51 OK, T-05 41 OK. Full T-14 suite not rerun (~12 min).

# T-14 debug (round 2)
- Cause: round-1 edits never reached the tree (HEAD d8efb42 held only the note); egress_probe.sh was still auth-only and container_hardening.py lacked --memory-budget, so all 10 failures were exit 2 (usage).
- Fix: egress_probe.sh +db|edge|proxy (probe_lib.sh, fail-closed; proxy: allowed via http_code, denied must be 403 via http_connect); container_hardening.py +--memory-budget (sum mem_limit x replicas <= max-pct% RAM, unbounded service named, exact Fraction math).
- Ran: T-14 EgressProbeModes + MemoryBudgetTool, T-03, T-05 static suites: 106 OK (1 skipped). Full T-14 suite not rerun.
