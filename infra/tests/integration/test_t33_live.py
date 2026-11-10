"""T-33 live test (tester role): real `nginx -t` with partner_enabled on, real login-zone flood on the partner origin.
Only with LIMS_T33_LIVE=1 (docker + openssl on PATH). NOT run by the tester (no nginx here).
Reuses the T-13 live harness: renders every site with partner_enabled=True, throw-away ECDSA certs, upstreams unreachable on
purpose (limited -> 429, passed -> 502/504). The Realtime half of done_when (`docker compose config` with the flag on) is covered by
infra/tests/static/test_t33_partner_realtime.py (CLI only, no daemon).
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_t13_live as t13live  # noqa: E402

LIVE = os.environ.get("LIMS_T33_LIVE") == "1"


@unittest.skipUnless(LIVE, "set LIMS_T33_LIVE=1 (docker + openssl) to run the live partner test")
class LivePartner(t13live.LiveEdge):
    """Inherits the T-13 fixtures; the inherited tests re-run with the partner server present (nginx -t, headers on every origin)."""

    def test_20_partner_login_flood(self):  # AC-04.1 partner part: 41 POST at once -> ~20 x 429 + Retry-After 60
        res = self.burst(t13live.HOSTS["partner"], "POST", "/auth/login", 41)
        lim = [r for r in res if r[0] == 429]
        self.assertIn(len(lim), (19, 20, 21))
        self.assertEqual(lim[0][1]["retry-after"], "60")

    def test_21_partner_reserved_prefixes_404(self):  # AC-06.1
        for p in ("/v1/identity/auth/partner/login", "/realtime/v1/websocket", "/rest/v1/x", "/mcp"):
            self.assertEqual(self.req(t13live.HOSTS["partner"], "GET", p)[0], 404, p)

    def test_22_partner_get_login_page_not_limited(self):  # only POSTs count
        res = self.burst(t13live.HOSTS["partner"], "GET", "/auth/login", 60)
        self.assertEqual([r for r in res if r[0] == 429], [])


del t13live.LiveEdge  # keep unittest from collecting the imported base class twice

if __name__ == "__main__":
    unittest.main()
