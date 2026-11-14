"""T-04 live connection matrix (CI only, LD-17-style gate): set LIMS_T04_LIVE=1 and have docker.

Builds infra/images/postgres-pgbackrest/Dockerfile, starts it with the rendered zz-lims.conf + pg_hba,
then connects with psql from a sidecar container on (a) the allowed bridge subnet and (b) a foreign subnet.
Run: set LIMS_T04_LIVE=1 && python -B -m unittest discover -s infra/tests/integration -p "test_t04_*.py" -v
"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "infra" / "tests" / "static"))
import test_t04_postgres_image as st  # noqa: E402

LIVE = os.environ.get("LIMS_T04_LIVE") == "1"
IMG, NET_OK, NET_BAD, PW = "lims-t04-pg:test", "lims_t04_ok", "lims_t04_bad", "t04-synthetic-pw"
ROLES = ("supabase_auth_admin", "authenticator", "supabase_storage_admin", "pgbouncer")


def sh(*a, check=True):
    return subprocess.run(a, capture_output=True, text=True, check=check)


@unittest.skipUnless(LIVE, "live docker test: CI only (LIMS_T04_LIVE=1)")
class Live(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        (d / "zz-lims.conf").write_text(st.render("zz-lims.conf*"), encoding="utf-8")
        (d / "pg_hba.conf").write_text(st.render("pg_hba.conf*"), encoding="utf-8")
        sh("docker", "build", "-t", IMG, str(st.DOCKERFILE.parent))
        sh("docker", "network", "create", "--subnet", st.SUBNETS["db"], NET_OK, check=False)
        sh("docker", "network", "create", "--subnet", "172.31.99.0/24", NET_BAD, check=False)
        sh("docker", "rm", "-f", "lims_t04_db", check=False)
        sh("docker", "run", "-d", "--name", "lims_t04_db", "--network", NET_OK, "--ip", "172.30.50.2",
           "-e", "POSTGRES_PASSWORD=" + PW,
           "-v", "%s:/etc/postgresql-custom/conf.d/zz-lims.conf:ro" % (d / "zz-lims.conf"),
           "-v", "%s:/etc/postgresql/pg_hba.conf:ro" % (d / "pg_hba.conf"), IMG)
        sh("docker", "network", "connect", "--ip", "172.31.99.2", NET_BAD, "lims_t04_db")
        for _ in range(60):
            if sh("docker", "exec", "lims_t04_db", "pg_isready", "-U", "postgres", check=False).returncode == 0:
                break
            time.sleep(2)

    @classmethod
    def tearDownClass(cls):
        sh("docker", "rm", "-f", "lims_t04_db", check=False)
        for n in (NET_OK, NET_BAD):
            sh("docker", "network", "rm", n, check=False)
        cls.tmp.cleanup()

    def psql(self, net, host, user, sql="select 1", db="postgres"):
        return sh("docker", "run", "--rm", "--network", net, "-e", "PGPASSWORD=" + PW, IMG, "psql", "-h", host,
                  "-U", user, "-d", db, "-tAc", sql, check=False)

    def test_roles_connect_from_allowed_subnet(self):
        for r in ROLES:
            p = self.psql(NET_OK, "172.30.50.2", r)
            self.assertEqual(p.returncode, 0, "%s: %s" % (r, p.stderr))

    def test_roles_rejected_from_foreign_subnet(self):
        for r in ROLES:
            self.assertNotEqual(self.psql(NET_BAD, "172.31.99.2", r).returncode, 0, r)

    def test_settings(self):
        for k, v in (("wal_level", "logical"), ("log_parameter_max_length", "0"),
                     ("log_parameter_max_length_on_error", "0"), ("password_encryption", "scram-sha-256")):
            p = sh("docker", "exec", "lims_t04_db", "psql", "-U", "supabase_admin", "-d", "postgres", "-tAc", "SHOW " + k)
            self.assertEqual(p.stdout.strip(), v, k)


if __name__ == "__main__":
    unittest.main()
