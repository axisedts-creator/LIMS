"""T-27 live test (tester role): AC-19.2 load test. Only with LIMS_T27_LIVE=1 on ops-1 against dev/staging.
NEVER RUN by the tester (no ansible, sops, docker, Postgres here). Never point it at prod.

Env: LIMS_T27_INVENTORY (repo-root-relative or absolute, e.g. infra/ansible/inventories/staging/hosts.yml),
LIMS_T27_ENV (dev|staging), LIMS_T27_ENC_FILE (path of <env>.enc.yaml -> -e secrets_render_enc_file),
LIMS_T27_PROBE_BASE (URL base the api answers on -> -e rotate_probe_base),
LIMS_T27_COMPOSE_ENV (JSON object, the dict deploy.yml passes -> -e rotate_compose_env),
LIMS_T27_PROBE_URL (https URL of the env's /v1/core/health/ready through the edge), LIMS_T27_CA_FILE (optional,
also -> -e rotate_probe_ca_file),
LIMS_T27_DURATION (seconds, default 300 = AC-19.2).
AC-19.2: Given a rotation run for the `lims_api` DB password, Then the API reconnects with the new password with zero
failed requests over 5 min of synthetic load. The load runs from before the rotation until after it; a failed
request or a non-zero playbook exit fails the test.
"""
import json
import os
import subprocess
import sys
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = os.environ.get("LIMS_T27_LIVE") == "1"
E = os.environ.get("LIMS_T27_ENV", "staging")


def playbook_cmd(env):
    """ansible-playbook argv carrying every input the playbook's 'Inputs of the DB flow are present' assert needs.
    The inventory is resolved against the repo root (cwd of the run is infra/ansible)."""
    cmd = ["ansible-playbook", "-i", str((ROOT / env["LIMS_T27_INVENTORY"]).resolve()),
           str(ROOT / "infra" / "ansible" / "playbooks" / "rotate-secret.yml"),
           "-e", "secret_id=lims_api_password", "-e", "env=" + env.get("LIMS_T27_ENV", "staging"),
           "-e", "secrets_render_enc_file=" + env["LIMS_T27_ENC_FILE"],
           "-e", "rotate_probe_base=" + env["LIMS_T27_PROBE_BASE"],
           "-e", json.dumps({"rotate_compose_env": json.loads(env["LIMS_T27_COMPOSE_ENV"])})]
    if env.get("LIMS_T27_CA_FILE"):
        cmd += ["-e", "rotate_probe_ca_file=" + env["LIMS_T27_CA_FILE"]]
    return cmd


@unittest.skipUnless(LIVE and E in ("dev", "staging"), "LIMS_T27_LIVE=1 and env dev|staging required (never prod)")
class Live(unittest.TestCase):
    def test_lims_api_password_rotation_zero_failed_requests(self):
        dur = os.environ.get("LIMS_T27_DURATION", "300")
        load = [sys.executable, "-I", str(ROOT / "infra" / "tests" / "internal" / "rotation_load.py"),
                "--url", os.environ["LIMS_T27_PROBE_URL"], "--duration", dur, "--rps", "5"]
        if os.environ.get("LIMS_T27_CA_FILE"):
            load += ["--ca-file", os.environ["LIMS_T27_CA_FILE"]]
        res = {}
        th = threading.Thread(target=lambda: res.update(p=subprocess.run(load, capture_output=True, text=True)))
        th.start()
        rot = subprocess.run(playbook_cmd(os.environ), capture_output=True, text=True,
                             cwd=str(ROOT / "infra" / "ansible"))
        th.join()
        self.assertEqual(rot.returncode, 0, rot.stdout[-2000:])
        p = res["p"]
        out = json.loads(p.stdout)
        self.assertEqual(out["failed"], 0, out)
        self.assertGreaterEqual(out["total"], int(dur) * 3)
        self.assertEqual(p.returncode, 0)
        self.assertNotIn("ALTER ROLE", rot.stdout + rot.stderr, "no SQL (it carries the new value) in the run output")


if __name__ == "__main__":
    unittest.main()
