"""N11 test: infra/ci/runtime-images.sh converts a release lock (release-lock.sh output) into `lims_runtime_images`.

Formats (read from the code, not invented):
 * lock   : infra/ci/release-lock.sh writes `env: <env>` + `images:` + `  "<repo>": "registry.lims.internal:5000/<repo>@sha256:<64 hex>"`.
 * var    : infra/ansible/roles/lims_runtime/tasks/main.yml asserts lims_runtime_images[<key>] ends in @sha256:<64 hex> for
            api worker web portal renderer pdf_sandbox valkey squid; infra/cutover/bootstrap.sh images_ok greps the same shape.
 * rule   : lib-deploy.sh read_lock maps `lims/<name>` to <name> with `-` as `_`.
Round trip on a synthetic lock built by release-lock.sh itself. Stdlib + PyYAML; bash required.
"""
import os
import re
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
CI = ROOT / "infra" / "ci"
REG = "registry.lims.internal:5000"
H = lambda c: c * 64  # noqa: E731  synthetic digest
LIMS = {"api": "a", "worker": "b", "web": "c", "portal": "d", "renderer": "e", "pdf-sandbox": "f", "postgres-pgbackrest": "0"}
MIRRORS = {"valkey/valkey": "1", "synthetic/squid": "2", "synthetic/clamd": "3"}  # synthetic upstream paths
REQUIRED = "api worker web portal renderer pdf_sandbox valkey squid".split()
MAPS = ["--map", "valkey=valkey/valkey", "--map", "squid=synthetic/squid", "--map", "clamd=synthetic/clamd"]


def refs(lims=LIMS, mirrors=MIRRORS):
    r = ["%s/lims/%s@sha256:%s" % (REG, n, H(c)) for n, c in lims.items()]
    r += ["%s/%s@sha256:%s" % (REG, p, H(c)) for p, c in mirrors.items()]
    return r


class RuntimeImagesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="n11"))
        self.rel = self.tmp / "releases"

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, True)

    def lock(self, env="staging", rs=None):
        r = subprocess.run(["bash", str(CI / "release-lock.sh"), env, *(rs or refs())], capture_output=True, text=True,
                           env={**os.environ, "RELEASES_DIR": str(self.rel)})
        self.assertEqual(r.returncode, 0, r.stderr)
        return self.rel / ("%s.lock.yaml" % env)

    def conv(self, *args, env="staging"):
        return subprocess.run(["bash", str(CI / "runtime-images.sh"), env, *args], capture_output=True, text=True,
                              env={**os.environ, "RELEASES_DIR": str(self.rel)})

    def test_round_trip(self):
        self.lock()
        out = self.tmp / "images.yml"
        r = self.conv("--out", str(out), *MAPS)
        self.assertEqual(r.returncode, 0, r.stderr)
        got = yaml.safe_load(out.read_text(encoding="utf-8"))["lims_runtime_images"]
        want = {"api": REG + "/lims/api@sha256:" + H("a"), "worker": REG + "/lims/worker@sha256:" + H("b"),
                "web": REG + "/lims/web@sha256:" + H("c"), "portal": REG + "/lims/portal@sha256:" + H("d"),
                "renderer": REG + "/lims/renderer@sha256:" + H("e"), "pdf_sandbox": REG + "/lims/pdf-sandbox@sha256:" + H("f"),
                "valkey": REG + "/valkey/valkey@sha256:" + H("1"), "squid": REG + "/synthetic/squid@sha256:" + H("2"),
                "clamd": REG + "/synthetic/clamd@sha256:" + H("3")}
        self.assertEqual(got, want)  # the DB image lims/postgres-pgbackrest is not a runtime image: skipped
        self.assertEqual(stat.S_IMODE(out.stat().st_mode), 0o600)
        text = out.read_text(encoding="utf-8")
        for k in REQUIRED:  # the exact check bootstrap.sh images_ok applies
            self.assertRegex(text, r'(?m)^[ \t]+"?%s"?:[ \t]*"?[^ \t"]+@sha256:[0-9a-f]{64}"?[ \t]*$' % k)
        self.assertRegex(text, r"(?m)^lims_runtime_images:")
        for v in got.values():  # the role's assert
            self.assertRegex(v, r"@sha256:[0-9a-f]{64}$")

    def test_stdout_and_dry_run_write_nothing(self):
        self.lock()
        r = self.conv(*MAPS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("lims_runtime_images:", r.stdout)
        out = self.tmp / "never.yml"
        r = self.conv("--out", str(out), "--dry-run", *MAPS)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(out.exists())
        self.assertIn("lims_runtime_images:", r.stdout)

    def test_missing_required_key_fails_and_writes_nothing(self):
        self.lock()
        out = self.tmp / "images.yml"
        r = self.conv("--out", str(out))  # no --map: valkey and squid unmapped
        self.assertEqual(r.returncode, 1)
        self.assertIn("valkey", r.stderr)
        self.assertIn("squid", r.stderr)
        self.assertFalse(out.exists())
        self.lock("dev", refs({k: v for k, v in LIMS.items() if k != "portal"}))
        r = self.conv("--out", str(out), *MAPS, env="dev")
        self.assertEqual(r.returncode, 1)
        self.assertIn("portal", r.stderr)

    def test_bad_input_exit_2(self):
        self.lock()
        for args, env in ((["--map", "valkey=no/such"], "staging"), (["--map", "bogus=valkey/valkey"], "staging"),
                          (["--map", "valkey"], "staging"), (["--nope"], "staging"), ([], "qa")):
            self.assertEqual(self.conv(*args, env=env).returncode, 2, (args, env))
        self.lock("dev")
        lock = self.rel / "dev.lock.yaml"  # env line that disagrees with the file name
        lock.write_text(lock.read_text(encoding="utf-8").replace("env: dev", "env: prod"), encoding="utf-8")
        self.assertEqual(self.conv(*MAPS, env="dev").returncode, 2)
        bad = self.rel / "staging.lock.yaml"
        bad.write_text(bad.read_text(encoding="utf-8").replace("sha256:" + H("a"), "sha256:abc"), encoding="utf-8")
        self.assertEqual(self.conv(*MAPS).returncode, 2)

    def test_script_hygiene(self):
        t = (CI / "runtime-images.sh").read_text(encoding="utf-8")
        self.assertNotIn("\r", t)
        self.assertRegex(t, r"(?m)^set -euo pipefail$")
        self.assertIsNone(re.search(r":latest\b", t))


if __name__ == "__main__":
    unittest.main()
