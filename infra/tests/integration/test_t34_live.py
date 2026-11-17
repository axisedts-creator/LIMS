"""T-34 live test (tester role): staging release with a TEST certificate, downloaded by a test agent through E08.
Only with LIMS_T34_LIVE=1 on the staging VM (docker, openssl, bash). NOT run by the tester (no staging here).
Env: LIMS_T34_VERSION (default 0.0.1, a throwaway version), LIMS_T34_ARTIFACT (test zip), LIMS_T34_API (api-a base URL),
LIMS_T34_DEVICE_TOKEN (test agent credential, C7), LIMS_T34_RELEASE_ID (id of the seeded row), LIMS_T34_APP_SSH (optional,
`user@host` of the app host when ops-1 and app-1 differ; app-side checks run through it).
Covers AC-31.1 (RW=false + write fails), AC-31.2 (zip in mount, ops_audit lines, no key/cert on app-1), done_when (E08 download).
"""
import hashlib
import os
import shlex
import subprocess
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = os.environ.get("LIMS_T34_LIVE") == "1"
APP = os.environ.get("LIMS_T34_APP_SSH", "")
VERSION = os.environ.get("LIMS_T34_VERSION", "0.0.1")
RW_FMT = "'" + "{{range .Mounts}}{{if eq .Destination \"/run/lims/agent-releases\"}}{{.RW}}{{end}}{{end}}" + "'"


def app(cmd):
    argv = ["ssh", APP, cmd] if APP else ["bash", "-c", cmd]
    return subprocess.run(argv, capture_output=True, text=True, timeout=120)


@unittest.skipUnless(LIVE, "set LIMS_T34_LIVE=1 on staging to run the live agent-release test")
class LiveAgentRelease(unittest.TestCase):
    def test_10_mount_is_read_only(self):  # AC-31.1
        for n in ("api-a", "api-b"):
            cid = "$(docker compose -p lims ps -q %s)" % n
            r = app("docker inspect -f %s %s" % (RW_FMT, cid))
            self.assertEqual(r.stdout.strip(), "false", n + r.stderr)
            w = app("docker exec %s sh -c 'touch /run/lims/agent-releases/.w' 2>&1" % cid)
            self.assertNotEqual(w.returncode, 0, n + ": write into the release mount must fail")

    def test_20_release_run_and_download(self):  # AC-31.2 + done_when
        r = subprocess.run(["bash", str(ROOT / "infra/ci/agent-release.sh"), VERSION], capture_output=True, text=True, timeout=600,
                           env=dict(os.environ, LIMS_AGENT_RELEASE_ARTIFACT=os.environ["LIMS_T34_ARTIFACT"]))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        z = app("ls /srv/lims/agent-releases/ | grep -F %s" % shlex.quote(VERSION))
        self.assertEqual(z.returncode, 0, "signed zip missing in the mount")
        url = "%s/v1/instruments/agent/releases/%s/package" % (os.environ["LIMS_T34_API"], os.environ["LIMS_T34_RELEASE_ID"])
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + os.environ["LIMS_T34_DEVICE_TOKEN"]})
        with urllib.request.urlopen(req, timeout=60) as resp:  # E08 downloadAgentRelease
            body = resp.read()
            self.assertEqual(resp.headers["X-Package-Sha256"], hashlib.sha256(body).hexdigest())
            self.assertEqual(int(resp.headers["Content-Length"]), len(body))

    def test_30_keys_never_on_app_host(self):  # AC-31.2 / AC-19.3 (full profile: app host is not ops-1)
        r = app("find /run/lims /srv/lims /etc/lims -name 'instruments_release_signing_key*' -o -name 'instruments_authenticode_cert*' 2>/dev/null")
        self.assertEqual(r.stdout.strip(), "", "release key/cert file on the app host")
        m = app("docker ps -q | xargs -r -n1 docker inspect | grep -c -e instruments_release_signing_key -e instruments_authenticode_cert || true")
        self.assertEqual(m.stdout.strip(), "0", "release key/cert visible in a container")

    def test_40_ops_audit_lines(self):  # AC-31.2: ids only, never content
        r = subprocess.run(["bash", "-c", "journalctl --since '-30min' | grep ops_audit"], capture_output=True, text=True)
        for sid in ("instruments_release_signing_key", "instruments_authenticode_cert"):
            self.assertIn(sid, r.stdout, "no ops_audit line for the read of " + sid)
        self.assertNotIn("BEGIN", r.stdout)


if __name__ == "__main__":
    unittest.main()
