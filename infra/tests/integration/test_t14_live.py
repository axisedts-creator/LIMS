"""T-14 live tests (tester role). Only with LIMS_T14_LIVE=1 on a host that runs the LIMS stack (dev VM / staging).
NEVER RUN by the tester (no docker, no C0/C6 images here).

Env: LIMS_T14_PROJECT (compose project, default `lims`), LIMS_T14_COMPOSE_ENV (env file for `docker compose`), DATA_WG_IP,
HOST_RAM_GIB, PROBE_IMAGE (digest-pinned image with nc), PROM_URL (optional, for up{job="worker"}),
LIMS_T14_LONGJOB_CMD (shell command that enqueues one synthetic job of ~30 s and prints its id; optional),
LIMS_T14_LONGJOB_STATUS_CMD (command taking the id, exit 0 when the job finished).
Covers AC-08.1 (SIGKILL restart <= 10 s, up -> 1 within 60 s), AC-08.2 (SIGTERM drain), AC-09.1/.3, AC-10.1, AC-11.1, AC-30.1.
"""
import json
import os
import shlex
import subprocess
import sys
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
INTERNAL = ROOT / "infra" / "tests" / "internal"
COMPOSE = ROOT / "infra" / "compose" / "lims" / "compose.app.yml"
LIVE = os.environ.get("LIMS_T14_LIVE") == "1"
PROJECT = os.environ.get("LIMS_T14_PROJECT", "lims")


def sh(*a, **kw):
    return subprocess.run(list(a), capture_output=True, text=True, timeout=kw.pop("timeout", 300), **kw)


def cid(service):
    r = sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "ps", "-q", service)
    out = r.stdout.strip()
    if not out:
        raise AssertionError("service %s not running in project %s" % (service, PROJECT))
    return out.splitlines()[0]


def name(service):
    return sh("docker", "inspect", "-f", "{{.Name}}", cid(service)).stdout.strip().lstrip("/")


def script(rel, *args, env=None):
    e = dict(os.environ, **(env or {}))
    return subprocess.run(["bash", str(INTERNAL / rel), *args], capture_output=True, text=True, env=e, timeout=600)


@unittest.skipUnless(LIVE, "LIMS_T14_LIVE=1 and a running stack required")
class Live(unittest.TestCase):
    def test_services_healthy(self):  # done_when: services healthy
        r = sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "ps", "--format", "json")
        rows = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        self.assertTrue(rows)
        for row in rows:
            if row.get("Service") == "migrate":
                continue
            self.assertEqual(row.get("State"), "running", row)
            self.assertIn(row.get("Health"), ("healthy", ""), row)

    def test_memory_budget_of_rendered_config(self):  # AC-30.1 (add Supabase/exporter configs for a full-host sum)
        r = sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "config", "--format", "json")
        self.assertEqual(r.returncode, 0, r.stderr)
        p = ROOT / ".orchestra" / "notes" / "_t14_live_config.json"
        p.write_text(r.stdout, encoding="utf-8")
        try:
            m = sh(sys.executable, str(INTERNAL / "container_hardening.py"), "--memory-budget", "--ram-gib",
                   os.environ["HOST_RAM_GIB"], str(p))
            self.assertEqual(m.returncode, 0, m.stdout + m.stderr)
        finally:
            p.unlink(missing_ok=True)

    def test_sigkill_restart_within_10s(self):  # AC-08.1
        c = cid("worker-a")
        t0 = time.time()
        sh("docker", "kill", "-s", "KILL", c)
        while time.time() - t0 < 10:
            if sh("docker", "inspect", "-f", "{{.State.Running}}", c).stdout.strip() == "true":
                break
            time.sleep(0.5)
        else:
            self.fail("worker-a not running 10 s after SIGKILL")
        if os.environ.get("PROM_URL"):
            import urllib.parse
            import urllib.request
            q = urllib.parse.quote('min(up{job="worker"})')
            deadline = time.time() + 60
            while time.time() < deadline:
                v = json.load(urllib.request.urlopen("%s/api/v1/query?query=%s" % (os.environ["PROM_URL"], q), timeout=10))
                res = v["data"]["result"]
                if res and res[0]["value"][1] == "1":
                    return
                time.sleep(3)
            self.fail('up{job="worker"} not back to 1 within 60 s')

    def test_sigterm_drains_inflight_job(self):  # AC-08.2: job started before the stop finishes within stop_grace_period
        enq, status = os.environ.get("LIMS_T14_LONGJOB_CMD"), os.environ.get("LIMS_T14_LONGJOB_STATUS_CMD")
        if not (enq and status):
            self.skipTest("no synthetic long job configured")
        jid = subprocess.run(enq, shell=True, capture_output=True, text=True, timeout=60).stdout.strip()
        self.assertTrue(jid)
        time.sleep(5)  # let a worker pick it up
        t0 = time.time()
        r = sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "stop", "-t", "60", "worker-a")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertLess(time.time() - t0, 62)
        code = sh("docker", "inspect", "-f", "{{.State.ExitCode}}", cid_stopped("worker-a")).stdout.strip()
        self.assertEqual(code, "0", "worker must exit cleanly after draining (not 137 = SIGKILLed at the grace limit)")
        self.assertEqual(subprocess.run(shlex.split(status) + [jid], capture_output=True, timeout=30).returncode, 0, "job lost")
        sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "up", "-d", "worker-a")

    def test_renderer_egress(self):  # AC-09.1
        r = script("renderer_egress.sh", env={"RENDERER_CONTAINER": name("renderer"), "DATA_WG_IP": os.environ["DATA_WG_IP"],
                                              "PROBE_IMAGE": os.environ.get("PROBE_IMAGE", "")})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_sandbox_envelope_and_worker_only_reachability(self):  # AC-10.1; failing here => record br_netfilter outcome in DECISION.md
        r = script("sandbox_envelope.sh", env={"SANDBOX_CONTAINER": name("pdf-sandbox"), "SANDBOX_PORT": os.environ.get("SANDBOX_PORT", "8080"),
                                               "WORKER_CONTAINERS": name("worker-a"), "DENY_CONTAINERS": "%s %s" % (name("api-a"), name("renderer"))})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_valkey_ephemeral(self):  # AC-11.1
        r = script("valkey_ephemeral.sh", env={"VALKEY_CONTAINER": name("valkey")})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_egress_probes(self):  # AC-09.3
        env = {"DATA_WG_IP": os.environ["DATA_WG_IP"], "PROXY_ALLOWED_FQDN": os.environ.get("PROXY_ALLOWED_FQDN", ""),
               "PROXY_DENIED_FQDN": os.environ.get("PROXY_DENIED_FQDN", "denied.invalid")}
        for mode, svc in (("db", "api-a"), ("db", "worker-a"), ("edge", "web-a"), ("edge", "portal"), ("proxy", "api-a"), ("proxy", "worker-a")):
            r = script("egress_probe.sh", mode, name(svc), env=env)
            self.assertEqual(r.returncode, 0, "%s %s\n%s%s" % (mode, svc, r.stdout, r.stderr))


def cid_stopped(service):
    r = sh("docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "ps", "-a", "-q", service)
    return r.stdout.strip().splitlines()[0]


if __name__ == "__main__":
    unittest.main()
