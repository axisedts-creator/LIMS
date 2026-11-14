"""T-18 live tests - CI / dev ops VM only (LIMS_T18_LIVE=1; needs the monitoring stack up on this VM).

Env: PROM_URL (default http://127.0.0.1:9090), AM_URL (default http://127.0.0.1:9093),
     LIMS_T18_SMTP_CAPTURE_DIR (dir where the test relay drops one file per received message; staging relay in CI),
     LIMS_T18_ONCALL, LIMS_T18_WATCHDOG (the staging mailbox addresses, passed via env - never committed).
Proves done_when: every active target `up == 1` (AC-17.1); a synthetic page alert is e-mailed via the relay within
120 s with no PHI-class strings (AC-17.3); Watchdog reaches the second mailbox only.
Not run by the static gate (T-18-verify.cmd).
"""
import json
import os
import time
import unittest
import urllib.request
from pathlib import Path

LIVE = os.environ.get("LIMS_T18_LIVE") == "1"
PROM = os.environ.get("PROM_URL", "http://127.0.0.1:9090")
AM = os.environ.get("AM_URL", "http://127.0.0.1:9093")
CAP = Path(os.environ.get("LIMS_T18_SMTP_CAPTURE_DIR", "/nonexistent"))
ONCALL = os.environ.get("LIMS_T18_ONCALL", "")
WATCHDOG = os.environ.get("LIMS_T18_WATCHDOG", "")


def _get(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.load(r)


def _mails():
    return [p.read_text(errors="ignore") for p in CAP.glob("*")] if CAP.exists() else []


@unittest.skipUnless(LIVE, "set LIMS_T18_LIVE=1 on the ops VM with the stack up")
class LiveTest(unittest.TestCase):
    def test_all_targets_up(self):
        res = _get(PROM + "/api/v1/targets?state=active")["data"]["activeTargets"]
        self.assertGreaterEqual(len(res), 10)
        down = [(t["labels"].get("job"), t["scrapeUrl"], t.get("lastError")) for t in res if t["health"] != "up"]
        self.assertEqual(down, [], "targets not up")

    def test_page_alert_delivered_within_2_min_no_phi(self):
        marker = "T18TestPage%d" % int(time.time())
        body = [{"labels": {"alertname": marker, "severity": "page", "team": "ops"},
                 "annotations": {"summary": "synthetic delivery test", "runbook_url": "infra/runbooks/ops.md#test"}}]
        req = urllib.request.Request(AM + "/api/v2/alerts", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=15).read()
        deadline = time.time() + 120
        got = []
        while time.time() < deadline and not got:
            got = [m for m in _mails() if marker in m]
            time.sleep(5)
        self.assertTrue(got, "no e-mail with %s within 120 s" % marker)
        self.assertIn(ONCALL, got[0])
        self.assertNotIn(WATCHDOG, got[0])
        for bad in ("patient", "specimen", "barcode"):
            self.assertNotIn(bad, got[0].lower())

    def test_watchdog_reaches_second_mailbox_only(self):
        wd = [m for m in _mails() if "Watchdog" in m]
        self.assertTrue(wd, "no Watchdog mail yet (first send can take up to the group_wait)")
        for m in wd:
            self.assertIn(WATCHDOG, m)
            self.assertNotIn(ONCALL, m)


if __name__ == "__main__":
    unittest.main()
