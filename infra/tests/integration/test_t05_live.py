"""T-05 live tests - CI / dev VM only (LIMS_T05_LIVE=1; needs docker daemon + the supabase project up on this VM).

Env: LIMS_T05_SERVICE_KEY (synthetic service_role JWT of the dev stack), DATA_WG_IP, SMTP_RELAY_HOST,
     AUTH_CONTAINER (default supabase-auth-1), APP_NET (default supabase_app_net).
Proves done_when: GoTrue healthy; auth egress matches db_net rules (egress_probe.sh auth); Storage upload ->
download through api-gw from a container on app_net; gateway has no published port.
Not run by the static gate (T-05-verify.cmd).
"""
import json
import os
import subprocess
import unittest
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = os.environ.get("LIMS_T05_LIVE") == "1"
C = os.environ.get("AUTH_CONTAINER", "supabase-auth-1")
NET = os.environ.get("APP_NET", "supabase_app_net")
KEY = os.environ.get("LIMS_T05_SERVICE_KEY", "")


def sh(*a, timeout=120):
    return subprocess.run(list(a), capture_output=True, text=True, timeout=timeout)


def curl(*args):  # curl from a throwaway container on app_net only (what api/worker will do)
    return sh("docker", "run", "--rm", "--network", NET, "curlimages/curl:latest", "-s", "-S", "-o", "-", "-w", "\n%{http_code}", *args)


@unittest.skipUnless(LIVE, "set LIMS_T05_LIVE=1 on a VM with the stack up")
class LiveTest(unittest.TestCase):
    def test_gotrue_healthy(self):
        r = sh("docker", "inspect", "-f", "{{.State.Health.Status}}", C)
        self.assertEqual(r.stdout.strip(), "healthy", r.stderr)

    def test_auth_egress_probe(self):
        r = sh("bash", str(ROOT / "infra/tests/internal/egress_probe.sh"), "auth")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_gateway_publishes_nothing(self):
        r = sh("docker", "ps", "--filter", "name=api-gw", "--format", "{{.Ports}}")
        self.assertNotIn("->", r.stdout, "api-gw has a published port: " + r.stdout)

    def test_storage_roundtrip_via_gateway_from_app_net(self):
        self.assertTrue(KEY, "LIMS_T05_SERVICE_KEY required")
        auth = "Authorization: Bearer " + KEY
        bucket, obj, body = "t05" + uuid.uuid4().hex[:8], "probe.txt", "synthetic-" + uuid.uuid4().hex
        base = "http://api-gw:8000/storage/v1"
        out = curl("-X", "POST", base + "/bucket", "-H", auth, "-H", "Content-Type: application/json",
                   "-d", json.dumps({"name": bucket, "public": False}))
        self.assertTrue(out.stdout.rstrip().endswith("200"), out.stdout + out.stderr)
        up = curl("-X", "POST", "%s/object/%s/%s" % (base, bucket, obj), "-H", auth, "-H", "Content-Type: text/plain",
                  "--data-binary", body)
        self.assertTrue(up.stdout.rstrip().endswith("200"), up.stdout + up.stderr)
        down = curl("%s/object/%s/%s" % (base, bucket, obj), "-H", auth)
        self.assertEqual(down.stdout.rstrip().rsplit("\n", 1), [body, "200"], down.stdout + down.stderr)
        curl("-X", "DELETE", "%s/object/%s/%s" % (base, bucket, obj), "-H", auth)
        curl("-X", "DELETE", "%s/bucket/%s" % (base, bucket), "-H", auth)

    def test_removed_backends_are_404_not_hanging(self):  # Envoy with the functions/studio/... clusters absent
        for path in ("/functions/v1/x", "/realtime/v1/", "/pg/tables"):
            out = curl("-m", "10", "-H", "Authorization: Bearer " + KEY, "http://api-gw:8000" + path)
            self.assertRegex(out.stdout.rstrip().rsplit("\n", 1)[-1], r"^(404|403|401)$", path)


if __name__ == "__main__":
    unittest.main()
