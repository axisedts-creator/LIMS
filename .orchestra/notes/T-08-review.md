APPROVE
Re-review of def1b04..HEAD after `[writer] T-08 review fixes`:
- Prior 1 fixed: seed runner `pnpm db:seed` marked `UNVERIFIED - pending CR T-08` (deploy.yml:104-105); `.orchestra/cr/T-08.md` filed to C0-0B in CR template form, non-blocking.
- Prior 2 fixed: deploy.yml:9-11 now says T-24 inserts prod-only `pgbackrest backup --type=incr --repo=1` BEFORE `Apply migrations` (02-TRD s7.9 step 2).
Checked OK (unchanged since last review): names verbatim; marker guard before decrypt/psql, marker last with force:false; passwords on stdin/env with no_log, never argv; any_errors_fatal, no ignore_errors/rescue; `migrate` on external `db_net`, no ports, cap_drop ALL; `{{ db_primary_wg_ip }}`:5432 as lims_migrator; LD-45 groups only; owned paths only (infra/**, .orchestra notes/cr). RLS/permissions/rate tier/error codes not relevant to this task.
Static suite: `python -B -m unittest discover -s infra/tests/static -p "test_t08_*.py"` gave 27 tests OK.
Not verified: live run (LIMS_T08_LIVE, dev VM); supabase_admin password == POSTGRES_PASSWORD; failure-injection live test (skips); seed command name until CR T-08 resolves.
