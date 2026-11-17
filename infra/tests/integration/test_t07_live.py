"""T-07 live PgBouncer check (CI/staging only): set LIMS_T07_LIVE=1 and have docker.

Builds the T-04 image, starts it with the rendered zz-lims.conf + pg_hba, creates role lims_api, starts PgBouncer from
the lock's digest with the rendered pgbouncer.ini + a userlist rendered here for `pgbouncer`, then asserts
SHOW CONFIG (pool_mode, max_prepared_statements), that lims_api authenticates through port 6432 and that a
transaction-local setting does not leak to the next client on the same server connection (analogue of C0 AC-0D-2.3,
which C0 runs on staging). Synthetic passwords only.
Run: set LIMS_T07_LIVE=1 && python -B -m unittest discover -s infra/tests/integration -p "test_t07_*.py" -v
"""
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra" / "tests" / "static"))
sys.path.insert(0, str(ROOT / "infra" / "tests" / "integration"))
import test_t04_postgres_image as pg  # noqa: E402
import test_t07_pgbouncer as st  # noqa: E402

LIVE = os.environ.get("LIMS_T07_LIVE") == "1"
NET, DB, PGB, IMG = "lims_t07_net", "lims_t07_db", "lims_t07_pgb", "lims-t07-pg:test"
PW = "t07-synthetic-pw"


def sh(*a, check=True):
    return subprocess.run(a, capture_output=True, text=True, check=check)


def psql(host, user, db, sql, pw=PW):
    r = sh("docker", "run", "--rm", "--network", NET, "-e", "PGPASSWORD=" + pw, "supabase/postgres:17.6.1.136",
           "psql", "-h", host, "-p", "6432" if host == PGB else "5432", "-U", user, "-d", db, "-tAc", sql, check=False)
    return r


@unittest.skipUnless(LIVE, "live docker test: CI/staging only (LIMS_T07_LIVE=1)")
class Live(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        ini = st.render("postgres").replace("default_pool_size = 40", "default_pool_size = 1")
        (d / "pgbouncer.ini").write_text(ini, encoding="utf-8")
        auth_file = st.one(st.pgb()["pgbouncer"], "auth_file")
        (d / "userlist.txt").write_text('"pgbouncer" "%s"\n' % PW, encoding="utf-8")  # plain is fine for a synthetic test
        (d / "zz-lims.conf").write_text(pg.render("zz-lims.conf*"), encoding="utf-8")
        (d / "pg_hba.conf").write_text(pg.render("pg_hba.conf*"), encoding="utf-8")
        sh("docker", "build", "-t", IMG, str(pg.DOCKERFILE.parent))
        sh("docker", "network", "create", "--subnet", pg.SUBNETS["db"], NET, check=False)
        sh("docker", "rm", "-f", DB, PGB, check=False)
        sh("docker", "run", "-d", "--name", DB, "--network", NET, "--network-alias", "db", "-e", "POSTGRES_PASSWORD=" + PW,
           "-v", "%s:/etc/postgresql-custom/conf.d/zz-lims.conf:ro" % (d / "zz-lims.conf"),
           "-v", "%s:/etc/postgresql/pg_hba.conf:ro" % (d / "pg_hba.conf"), IMG)
        for _ in range(60):
            if sh("docker", "exec", DB, "pg_isready", "-U", "postgres", check=False).returncode == 0:
                break
            time.sleep(2)
        sh("docker", "exec", DB, "psql", "-U", "supabase_admin", "-d", "postgres", "-c",
           "CREATE ROLE lims_api LOGIN PASSWORD '%s'" % PW, check=False)
        sh("docker", "run", "-d", "--name", PGB, "--network", NET, "--network-alias", PGB,
           "-v", "%s:/etc/pgbouncer/pgbouncer.ini:ro" % (d / "pgbouncer.ini"),
           "-v", "%s:%s:ro" % (d / "userlist.txt", auth_file),
           "edoburu/pgbouncer@" + re.search(r"sha256:[0-9a-f]{64}", (st.LOCK).read_text()).group(0))
        time.sleep(5)

    @classmethod
    def tearDownClass(cls):
        sh("docker", "rm", "-f", DB, PGB, check=False)
        sh("docker", "network", "rm", NET, check=False)
        cls.tmp.cleanup()

    def test_show_config_effective(self):  # done_when
        r = psql(PGB, "pgbouncer", "pgbouncer", "SHOW CONFIG")
        self.assertEqual(r.returncode, 0, r.stderr)
        cfg = {ln.split("|")[0]: ln.split("|")[1] for ln in r.stdout.splitlines() if "|" in ln}
        self.assertEqual(cfg["pool_mode"], "transaction")
        self.assertEqual(cfg["max_prepared_statements"], "200")
        self.assertEqual(cfg["auth_type"], "scram-sha-256")

    def test_lims_api_authenticates_and_wrong_password_fails(self):
        self.assertEqual(psql(PGB, "lims_api", "postgres", "SELECT 1").stdout.strip(), "1")
        self.assertNotEqual(psql(PGB, "lims_api", "postgres", "SELECT 1", pw="wrong").returncode, 0)

    def test_lims_api_cannot_use_admin_console(self):
        self.assertNotEqual(psql(PGB, "lims_api", "pgbouncer", "SHOW CONFIG").returncode, 0)

    def test_unknown_database_rejected(self):
        self.assertNotEqual(psql(PGB, "lims_api", "template1", "SELECT 1").returncode, 0)

    def test_tx_local_setting_does_not_leak_on_shared_server_connection(self):  # AC-07.3 analogue (pool size 1)
        a = psql(PGB, "lims_api", "postgres", "BEGIN; SELECT set_config('app.t7', 'tenant-A', true); COMMIT;")
        self.assertEqual(a.returncode, 0, a.stderr)
        b = psql(PGB, "lims_api", "postgres", "SELECT coalesce(nullif(current_setting('app.t7', true), ''), 'NULL')")
        self.assertEqual(b.stdout.strip(), "NULL")


# LD-67 (2026-11-08, C1 T-06 reopened, settles CR-C1-T07): the same checks, but PgBouncer mounts the userlist as the
# secrets_render role renders it (T-06 test_t06_userlist.py pins the contract), not a hand-written one.
@unittest.skipUnless(LIVE, "live docker test: CI/staging only (LIMS_T07_LIVE=1)")
class LiveRenderedUserlist(unittest.TestCase):
    NET2, DB2, PGB2 = "lims_t07r_net", "lims_t07r_db", "lims_t07r_pgb"

    @classmethod
    def setUpClass(cls):
        import test_t06_userlist as ul  # noqa: E402  (static dir already on sys.path)
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        rendered = ul._render(PW)  # role template/content rendered with the synthetic password
        assert rendered == '"pgbouncer" "%s"\n' % PW, "role must render exactly one two-field line"
        (d / "userlist.txt").write_text(rendered, encoding="utf-8")
        os.chmod(d / "userlist.txt", 0o444)  # container uid differs from the CI user; 0400/owner proven statically
        ini = st.render("postgres").replace("default_pool_size = 40", "default_pool_size = 1")
        (d / "pgbouncer.ini").write_text(ini, encoding="utf-8")
        (d / "zz-lims.conf").write_text(pg.render("zz-lims.conf*"), encoding="utf-8")
        (d / "pg_hba.conf").write_text(pg.render("pg_hba.conf*"), encoding="utf-8")
        auth_file = st.one(st.pgb()["pgbouncer"], "auth_file")
        sh("docker", "build", "-t", IMG, str(pg.DOCKERFILE.parent))
        sh("docker", "network", "create", "--subnet", pg.SUBNETS["db"], cls.NET2, check=False)
        sh("docker", "rm", "-f", cls.DB2, cls.PGB2, check=False)
        sh("docker", "run", "-d", "--name", cls.DB2, "--network", cls.NET2, "--network-alias", "db",
           "-e", "POSTGRES_PASSWORD=" + PW,
           "-v", "%s:/etc/postgresql-custom/conf.d/zz-lims.conf:ro" % (d / "zz-lims.conf"),
           "-v", "%s:/etc/postgresql/pg_hba.conf:ro" % (d / "pg_hba.conf"), IMG)
        for _ in range(60):
            if sh("docker", "exec", cls.DB2, "pg_isready", "-U", "postgres", check=False).returncode == 0:
                break
            time.sleep(2)
        sh("docker", "exec", cls.DB2, "psql", "-U", "supabase_admin", "-d", "postgres", "-c",
           "CREATE ROLE lims_api LOGIN PASSWORD '%s'" % PW, check=False)
        sh("docker", "run", "-d", "--name", cls.PGB2, "--network", cls.NET2, "--network-alias", PGB,
           "-v", "%s:/etc/pgbouncer/pgbouncer.ini:ro" % (d / "pgbouncer.ini"),
           "-v", "%s:%s:ro" % (d / "userlist.txt", auth_file),
           "edoburu/pgbouncer@" + yaml.safe_load(st.LOCK.read_text(encoding="utf-8"))["images"]["pgbouncer"]["digest"])
        time.sleep(5)

    @classmethod
    def tearDownClass(cls):
        sh("docker", "rm", "-f", cls.DB2, cls.PGB2, check=False)
        sh("docker", "network", "rm", cls.NET2, check=False)
        cls.tmp.cleanup()

    def _psql(self, user, db, sql, pw=PW):
        return subprocess.run(
            ["docker", "run", "--rm", "--network", self.NET2, "-e", "PGPASSWORD=" + pw, "supabase/postgres:17.6.1.136",
             "psql", "-h", PGB, "-p", "6432", "-U", user, "-d", db, "-tAc", sql], capture_output=True, text=True)

    def test_pgbouncer_starts_with_rendered_file_mounted(self):
        r = sh("docker", "inspect", "-f", "{{.State.Running}}", self.PGB2, check=False)
        self.assertEqual(r.stdout.strip(), "true", sh("docker", "logs", self.PGB2, check=False).stderr[-300:])

    def test_show_config_effective_with_rendered_file(self):
        r = self._psql("pgbouncer", "pgbouncer", "SHOW CONFIG")
        self.assertEqual(r.returncode, 0, r.stderr)
        cfg = {ln.split("|")[0]: ln.split("|")[1] for ln in r.stdout.splitlines() if "|" in ln}
        self.assertEqual(cfg["pool_mode"], "transaction")
        self.assertEqual(cfg["max_prepared_statements"], "200")

    def test_lims_api_logs_in_via_auth_query_with_rendered_file(self):
        self.assertEqual(self._psql("lims_api", "postgres", "SELECT 1").stdout.strip(), "1")
        self.assertNotEqual(self._psql("lims_api", "postgres", "SELECT 1", pw="wrong").returncode, 0)

    def test_pgbouncer_image_uid_matches_secrets_render_uids(self):
        # review C1.T-06 item 2: the 0400 userlist is owned by secrets_render_uids.pgbouncer; it must be the image user.
        import test_t06_secrets as base  # noqa: E402
        img = "edoburu/pgbouncer@" + yaml.safe_load(st.LOCK.read_text(encoding="utf-8"))["images"]["pgbouncer"]["digest"]
        r = sh("docker", "run", "--rm", "--entrypoint", "id", img, "-u")
        self.assertEqual(int(r.stdout.strip()), base._defaults()["secrets_render_uids"]["pgbouncer"])


if __name__ == "__main__":
    unittest.main()
