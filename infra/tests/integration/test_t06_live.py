"""T-06 live checks on a rendered host (dev VM / CI). Skipped unless LIMS_T06_LIVE=1.

Env: LIMS_T06_ENV (dev|staging|prod, default dev). Needs docker CLI + root to read /run/lims/secrets.
AC-19.1: secrets dir is tmpfs, files 0400; docker inspect shows no file-secret value (tool: docker_inspect_secrets.py).
"""
import os
import stat
import subprocess
import sys
import unittest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SECRETS = "/run/lims/secrets"


@unittest.skipUnless(os.environ.get("LIMS_T06_LIVE") == "1", "live test: set LIMS_T06_LIVE=1 on a rendered host")
class LiveSecretsTest(unittest.TestCase):
    def test_secrets_dir_is_tmpfs(self):
        out = subprocess.run(["findmnt", "-no", "FSTYPE", "-T", SECRETS], capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "tmpfs")

    def test_every_secret_file_is_0400(self):
        n = 0
        for d, _, files in os.walk(SECRETS):
            for f in files:
                self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, f)).st_mode), 0o400, os.path.join(d, f))
                n += 1
        self.assertGreater(n, 0)

    def test_docker_inspect_scan_clean(self):
        env = os.environ.get("LIMS_T06_ENV", "dev")
        ids = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True, check=True).stdout.split()
        ins = subprocess.run(["docker", "inspect", *ids], capture_output=True, text=True, check=True).stdout
        p = subprocess.run([sys.executable, "-B", os.path.join(ROOT, "infra", "tests", "internal", "docker_inspect_secrets.py"),
                            "--inspect", "-", "--secrets-dir", SECRETS, "--schema",
                            os.path.join(ROOT, "infra", "secrets", "schema", "%s.secrets.schema.yaml" % env)],
                           input=ins, capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stdout)


if __name__ == "__main__":
    unittest.main()
