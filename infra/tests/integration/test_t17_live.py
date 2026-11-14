"""T-17 live tests - CI / dev VM only (LIMS_T17_LIVE=1; needs the logging stack up on this VM: Fluent Bit + VictoriaLogs + Docker).

Env: VL_URL (default http://127.0.0.1:9428), LIMS_T17_VL_DATA (VictoriaLogs data dir on this host, for the compression ratio),
     LIMS_T17_DOCKER (default `docker`).
Proves done_when: a synthetic container log line is searchable in VictoriaLogs < 60 s (AC-18.1, ingest latency test); the
planted synthetic PHI-like fields never reach the store (CV s9.2 planted-PHI log test); retention is 90 d (/flags); the
compression ratio of ~20 MB of synthetic nginx-style lines is >= 2.5x (TRD s14) and is printed so DECISION.md can quote it.
Not run by the static gate (C1.T-17-verify.cmd). Synthetic data only.
"""
import json
import os
import subprocess
import time
import unittest
import urllib.parse
import urllib.request
import uuid

LIVE = os.environ.get("LIMS_T17_LIVE") == "1"
VL = os.environ.get("VL_URL", "http://127.0.0.1:9428")
DOCKER = os.environ.get("LIMS_T17_DOCKER", "docker")
DATA = os.environ.get("LIMS_T17_VL_DATA", "")


def query(q, limit=50):
    data = urllib.parse.urlencode({"query": q, "limit": str(limit)}).encode()
    with urllib.request.urlopen(urllib.request.Request(VL + "/select/logsql/query", data=data), timeout=15) as r:
        return [json.loads(l) for l in r.read().decode().splitlines() if l.strip()]


def emit(line):
    """One line on stdout of a throw-away container: lands in /var/lib/docker/containers/*/*-json.log -> Fluent Bit."""
    subprocess.run([DOCKER, "run", "--rm", "--label", "lims.t17=synthetic", "alpine:3", "sh", "-c", "echo '%s'" % line.replace("'", "")],
                   check=True, capture_output=True, timeout=120)


@unittest.skipUnless(LIVE, "set LIMS_T17_LIVE=1 on the dev VM with the logging stack up")
class LiveTest(unittest.TestCase):
    def test_log_is_searchable_within_60s_and_phi_is_redacted(self):
        marker = "t17-" + uuid.uuid4().hex
        rec = {"msg": marker, "level": "info", "tenant_id": str(uuid.uuid4()), "patient_name": "Sita SYNTHETIC Sharma",
               "phone": "9841234567", "email": "synthetic@example.invalid", "otp": "482913", "result_text": "SYNTH-REACTIVE",
               "note": "call 9812345678 Bearer SYNTHBEARER.abc.def"}
        t0 = time.time()
        emit(json.dumps(rec))
        hits = []
        while time.time() - t0 < 60:
            hits = query('"%s"' % marker)
            if hits:
                break
            time.sleep(1)
        latency = time.time() - t0
        print("t17 ingest latency: %.1f s" % latency)
        self.assertTrue(hits, "marker not searchable after 60 s")
        blob = json.dumps(hits)
        for planted in ("Sita", "SYNTHETIC", "9841234567", "synthetic@example", "482913", "SYNTH-REACTIVE", "9812345678", "SYNTHBEARER"):
            self.assertNotIn(planted, blob, "planted value %r reached VictoriaLogs" % planted)
        self.assertIn("host", blob)

    def test_retention_is_90_days(self):
        with urllib.request.urlopen(VL + "/flags", timeout=15) as r:
            flags = r.read().decode()
        self.assertRegex(flags, r"retentionPeriod[^\n]*90d")

    def test_compression_ratio_measured(self):
        if not DATA or not os.path.isdir(DATA):
            self.skipTest("set LIMS_T17_VL_DATA to the VictoriaLogs data dir to measure the ratio")
        before = int(subprocess.run(["du", "-sb", DATA], capture_output=True, text=True, check=True).stdout.split()[0])
        lines, raw = [], 0
        for i in range(50000):
            ln = json.dumps({"_msg": "GET", "_time": "2026-11-08T00:47:%02dZ" % (i % 60), "service": "edge", "env": "dev", "host": "synthetic",
                             "edge_request_id": uuid.uuid4().hex, "remote_addr": "203.0.113.%d" % (i % 250), "route": "/v1/orders/%d" % (i % 97),
                             "status": "200", "bytes": str(300 + i % 900), "req_time": "0.0%02d" % (i % 90), "ua_class": "browser"})
            raw += len(ln) + 1
            lines.append(ln)
        req = urllib.request.Request(VL + "/insert/jsonline?_stream_fields=service,env,host&_msg_field=_msg&_time_field=_time",
                                     data="\n".join(lines).encode(), method="POST")
        urllib.request.urlopen(req, timeout=120).read()
        time.sleep(30)  # let the in-memory parts flush to disk
        after = int(subprocess.run(["du", "-sb", DATA], capture_output=True, text=True, check=True).stdout.split()[0])
        ratio = raw / max(after - before, 1)
        print("t17 compression ratio: %.1fx (raw %d B, on disk +%d B)" % (ratio, raw, after - before))
        self.assertGreaterEqual(ratio, 2.5)


if __name__ == "__main__":
    unittest.main()
