CHANGES

Reviewed `git diff 2aaea18..HEAD` against plan row T-09, PRD AC-12.1–12.4, TRD s9.1–9.4, 03-APP-FLOW s3.3, 07-SEC AB-7.
Ran: `python -B -m unittest discover -s infra/tests/static -p "test_t09_*.py"` -> 34 OK; test_t04 -> 31 OK.
Fine: metric names/labels verbatim (TRD s15 `{repo,type}`), `aes-256-cbc` both repos, no pass in committed files,
pass only on tmpfs + role only on `data`, timers UTC math correct (NPT +5:45), dev (no `dr`) renders without repo2,
SQL in metrics script built only from regex-validated hex, no PHI/secrets in output.

1. infra/tests/static/test_t09_pgbackrest.py:118 — false green. `\b[0-9a-f]{64}\b` matches the base-image digest
   (Dockerfile:539/557), not a tarball checksum; the tarball sha256 is empty (Dockerfile:543). Fix test:
   `self.assertRegex(t, r"(?m)^ARG PGBACKREST_TARBALL_SHA256=[0-9a-f]{64}\s*$", "tarball sha256 must be recorded (TRD s9.1)")`.
   Fix impl: set `ARG PGBACKREST_TARBALL_SHA256=<sha256 of https://github.com/pgbackrest/pgbackrest/archive/release/2.60.0.tar.gz>`
   computed on a host with network (CI), not invented.

2. infra/tests/static/test_t09_pgbackrest.py:462-469 — done_when tests pass on text that says the work was NOT done
   (DECISION.md:439 "NOT yet run", :451 "NOT measured yet", 24 GiB/day is the TRD estimate). Fix tests: in
   `DecisionTest` add `self.assertNotRegex(self.sec, r"(?i)\bNOT (yet run|measured|run)\b|still OPEN")` to
   test_records_wal_per_day_measured, test_check_ok_both_repos_and_full_incr_recorded and
   test_records_multi_repo_failure_behaviour, and require a measured line, e.g.
   `assertRegex(self.sec, r"(?im)^WAL volume per day \(measured[^)]*\):\s*\d+(\.\d+)?\s*(MiB|GiB)/day")`.
   Fix impl (infra/compose/supabase/DECISION.md:439-453): run on dev/staging (CI build + data-1/dr-1) and record
   `pgbackrest check` result for repo1 and repo2, first full + incr results, real `info`/`repo-ls --output=json`
   field names, the pgbackrest.org 2.60 multi-repo re-check, and the measured compressed WAL/day. Until then
   done_when is not met.

3. infra/ansible/roles/pgbackrest/files/lims-pgbackrest-check.sh:6,127 — the counter behind `WalArchiveFailing`
   (AC-12.2, page) is untested and untestable (binary and state paths hard-coded). Fix: use
   `state=${STATE_DIR:-/var/lib/lims/pgbackrest}/check_consecutive_failures` and
   `${PGBACKREST:-/usr/local/lib/lims/bin/pgbackrest}`; add a test that runs the script with a fake pgbackrest
   (fail, fail, ok) and asserts the state file reads 1, 2, 0 and exit codes 1, 1, 0.

4. infra/secrets/schema/{dev,staging,prod}.secrets.schema.yaml:224/223/224 — removing dr-1 as repo2-pass consumer
   (correct per AC-12.3) leaves an unresolved spec conflict with 02-TRD s9.5 (dr-1 standby `restore --type=standby`
   from repo2 + `archive-get` need the repo2 pass on dr-1). Noted only in T-09-impl.md:13. Fix: write
   `.orchestra/cr/T-09.md` with the CR template (spec/program/04-CHANGE-REQUESTS.md) naming AC-12.3 vs TRD s9.5
   and the affected tasks T-10/T-12.
