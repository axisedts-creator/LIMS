"""T-28 live dry-run test (tester role). Only with LIMS_T28_LIVE=1 on ops-1 with ansible-playbook installed.
NEVER RUN by the tester (no ansible here). `--check` only: this test never patches anything.

Env: LIMS_T28_INVENTORY_DIR (repo-root-relative or absolute, e.g. infra/ansible/inventories/staging; default dev inventory).
done_when (T-28): the monthly flow dev->staging->prod runs in dry-run, and the emergency path too.
 1. --syntax-check passes.
 2. dev --check passes without evidence; staging/prod --check are refused without `patch_previous_done_at`.
 3. prod --check with evidence >= 24 h old passes; with evidence 1 h old it is refused unless patch_emergency=true.
 4. --check never writes /var/lib/lims/patch/last_patch_timestamp (the metric must not move on a dry run).
"""
import os
import subprocess
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = os.environ.get("LIMS_T28_LIVE") == "1"
PLAY = ROOT / "infra" / "ansible" / "playbooks" / "patch.yml"
INV = (ROOT / os.environ.get("LIMS_T28_INVENTORY_DIR", "infra/ansible/inventories/dev")).resolve()


def run(*extra):
    cmd = ["ansible-playbook", "-i", str(INV / "hosts.yml"), str(PLAY), *extra]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=str(ROOT / "infra" / "ansible"))


@unittest.skipUnless(LIVE, "LIMS_T28_LIVE=1 required")
class DryRun(unittest.TestCase):
    env = INV.name.split("-")[0]

    def test_syntax(self):
        self.assertEqual(run("--syntax-check").returncode, 0)

    def test_monthly_dry_run_order(self):
        now = int(time.time())
        if self.env == "dev":
            self.assertEqual(run("--check").returncode, 0)
            return
        self.assertNotEqual(run("--check").returncode, 0, "no evidence from the previous environment")
        ok = run("--check", "-e", "patch_previous_done_at=%d" % (now - 2 * 86400))
        self.assertEqual(ok.returncode, 0, ok.stdout[-2000:])
        if self.env == "prod":
            soon = ("--check", "-e", "patch_previous_done_at=%d" % (now - 3600))
            self.assertNotEqual(run(*soon).returncode, 0, "24 h soak")
            self.assertEqual(run(*soon, "-e", "patch_emergency=true").returncode, 0, "emergency skips the soak")
