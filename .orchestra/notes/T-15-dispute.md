# T-15 dispute (writer)
Two tests in `infra/tests/static/test_t15_auditstore.py` contradict each other; no implementation can pass both.
- `RoleStatic.test_job_psql_wrapper_forces_tcp_loopback` (l.562-565, added for review item 1) requires the literal `-e PGHOST=127.0.0.1` in `psql.j2`.
- `RoleStatic.test_no_literal_hosts_ips_or_secrets_and_cites_decisions` (l.536) forbids any IPv4 literal (`\b\d{1,3}(\.\d{1,3}){3}\b`) in the role.
Why the first is right: pg_hba.conf.j2:11 has the scram line for `127.0.0.1/32`; `localhost` may resolve to `::1` and miss it, and the socket hits `peer map=supabase_map` (no job roles). Loopback is not a host address, so LD-45 "no host names/addresses" is not at stake.
Proposed test fix: l.536 exclude loopback, e.g. `self.assertNotRegex(re.sub(r"\b127\.0\.0\.1\b", "", self.code), r"\b\d{1,3}(\.\d{1,3}){3}\b")`.
Current state: psql.j2 has `PGHOST=127.0.0.1` (reviewer item 1); result 62/63, only l.536 fails.
