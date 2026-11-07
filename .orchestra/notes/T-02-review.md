APPROVE

Diff b15267f..HEAD: test-only changes (infra/tests/static/test_t02_providers.py) + T-02 notes. All 5 items of the previous CHANGES review are fixed:
1. ENVS now covers dev, staging, prod, staging-lean, prod-lean; layout/parse/subnet/known_hosts/public_ip/ansible-inventory loops run over all; `test_no_inventory_dir_escapes_the_tests` locks the set.
2. LD-48 role mapping: prod-lean = prod-1 in data/app/ops only, backup-1 in `backup` only, `dr` empty; staging-lean = one VM; every role group has a host in each profile.
3. LD-45 memory budget: `mem_problems` + gate self-check; prod-lean/prod-1 pinned to 32 GiB, sum 25.375 <= 27.2.
4. prod-lean named default in infra/README.md and DECISION.md; scale triggers (CPU > 60 %, RAM > 80 %, 7 days, DB > 150 GB, second lab group) asserted.
5. `backup` in lean GROUPS/GVARS; group_vars/backup.yml required.
Provider scan matches T-02-ruling.md items 1-4 (hosting-context regex, vendored upstream skipped, 169.254.169.254 allowed only under tests/, planted self-check extended).

Ran: T-02 suite 33 tests OK, 1 skip (ansible-inventory off CI, LD-17). yamllint on infra/ansible/inventories + infra/providers clean.
Not T-02: T-01 suite has 3 failures (gitleaks on infra/compose/supabase/upstream/.env.example, yamllint on compose/supabase/override.app.yml, run.sh line-length) — all T-05 paths, outside this diff.
No secrets, no PHI, only owned paths, no invented names. RLS/permissions/error codes N/A (inventory task).
Carry-over (not blocking): T-09/T-11 must target group `backup` (not `dr`) in lean; backup-1 has no mem budget in LD-45.
