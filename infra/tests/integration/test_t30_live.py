"""T-30 live test (tester role). Only with LIMS_T30_LIVE=1 on ops-1 of a DEPLOYED staging or prod environment.
NEVER RUN by the tester (no VMs here). Read-only: scans public IPs and reads `systemctl` / `nft`.

Env: LIMS_T30_INVENTORY_DIR (e.g. infra/ansible/inventories/staging-lean), LIMS_T30_PUBLIC_IFACE (e.g. eth0).
done_when (T-30): `run.sh all` green on staging and prod (LIMS_ENV=staging|prod bash infra/tests/run.sh all, run by the operator);
the monthly scan timer is installed and enabled on ops-1. This file checks the two things that need a live host:
 1. ports.py (AC-01.1/01.2) is green for the whole inventory (TCP 1-65535 of every public IP + UDP 51820).
 2. `nft list ruleset` of this host passes nft_ruleset.py (AC-01.4).
 3. lims-external-scan.timer is enabled and has a next elapse.
"""
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = os.environ.get("LIMS_T30_LIVE") == "1"
INV = (ROOT / os.environ.get("LIMS_T30_INVENTORY_DIR", "infra/ansible/inventories/staging")).resolve()
IFACE = os.environ.get("LIMS_T30_PUBLIC_IFACE", "")


def sh(*a, timeout=7200):
    return subprocess.run(list(a), capture_output=True, text=True, cwd=str(ROOT), timeout=timeout)


@unittest.skipUnless(LIVE, "LIMS_T30_LIVE=1 required")
class Live(unittest.TestCase):
    def test_external_port_scan_green(self):
        r = sh("python3", "infra/tests/external/ports.py", "--inventory", str(INV))
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])

    def test_nft_ruleset_of_this_host(self):
        self.assertTrue(IFACE, "set LIMS_T30_PUBLIC_IFACE")
        r = sh("python3", "infra/tests/internal/nft_ruleset.py", "--public-iface", IFACE)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])

    def test_scan_timer_enabled_with_next_run(self):
        self.assertEqual(sh("systemctl", "is-enabled", "lims-external-scan.timer").stdout.strip(), "enabled")
        r = sh("systemctl", "show", "lims-external-scan.timer", "-p", "NextElapseUSecRealtime", "--value")
        self.assertTrue(r.stdout.strip(), "timer has no next elapse (not active)")


if __name__ == "__main__":
    unittest.main()
