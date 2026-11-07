# T-14 debug (round 1)
- Cause: verify log 10 failures, all exit 2 (usage): `egress_probe.sh` had only `auth` mode; `container_hardening.py` had no `--memory-budget`. impl note claimed both added but tree/HEAD lacked them.
- Fix: egress_probe.sh +db|edge|proxy (via probe_lib.sh, fail-closed; proxy: allowed status via %{http_code}, denied must be 403 via %{http_connect}, direct egress denied); container_hardening.py +--memory-budget (Σ mem_limit×replicas ≤ max-pct% RAM, unbounded service named).
- Ran: T-14 MemoryBudgetTool + EgressProbeModes 14/14 OK; T-03 51 OK, T-05 41 OK. Full T-14 suite not rerun (~12 min).
