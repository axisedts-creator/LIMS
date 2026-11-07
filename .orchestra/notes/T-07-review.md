APPROVE

Re-review after `8453e05` (review fixes). Static suite: `python -B -m unittest discover -s infra/tests/static -p "test_t07_*.py"` -> 24/24 OK. Live test (`LIMS_T07_LIVE=1`) not run (no docker here).
- ini values match 02-TRD s7.6 verbatim (trailing comments moved to own lines, correctly); pool_mode=transaction, max_prepared_statements=200, auth_user=pgbouncer added (required for auth_query), no `*` database, no secrets, LD-45 cited, only owned paths.
- `supavisor: !reset null` kept (AC-07.1); pgbouncer pinned digest v1.25.2-p0 >= 1.21.
- Prior item 1 resolved via option (a): `.orchestra/cr/T-07.md` filed (secrets_render to render `/run/lims/secrets/pgbouncer/userlist.txt`, 0400, plaintext). Infra code unchanged, which is correct for that option.
- Condition (not a T-07 code defect): deploy of T-07 to data-1/prod-1 is blocked until CR-C1-T07 lands; done_when "lims_api authenticates" and AC-07.3 (C0 AC-0D-2.3 on staging) must be proven by `test_t07_live.py` + staging run after that. AC-07.2 API URLs belong to T-14.
