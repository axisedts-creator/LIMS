"""C1.T-32 tests (tester role): flood/load test `infra/tests/load/flood.js` (k6), AC-24.1.

AC-24.1: staging flood at 10x the 04 s14 burst (5,000 req/s for 60 s) -> nginx sheds with 429/503, API p95 for authenticated
staff traffic < 2x baseline, no host out of file descriptors. 02-TRD s17: PgBouncer `cl_waiting` = 0 at the 500 req/s burst.
02-TRD s18: load test is staging only, synthetic data only. LD-45: `staging` and `staging-lean` are the only valid targets.

CONTRACT for the writer (flood.js is a k6 script; stdlib-only Python here, k6 must be on PATH):
 Env (read via __ENV; NEVER at init time, so `k6 inspect` works with no env — refusals happen in setup()):
   TARGET_URL      base URL of the staging edge (required)
   TARGET_ENV      must be `staging` or `staging-lean`; anything else (prod, prod-lean, dev, unset) -> k6 exits non-zero
                   BEFORE sending a single request
   STAFF_URL       OPTIONAL (default TARGET_URL): base URL used for ALL authenticated traffic (calibration, baseline, burst,
                   staff probe). The anonymous flood always goes to TARGET_URL. Lets the staff/burst traffic come through a
                   second address that the flood IP's edge rate-limit / fail2ban does not shed (review T-32 item 2).
   STAFF_TOKEN     synthetic bearer for the authenticated staff probe (required; no token literal in the file; never sent
                   on flood traffic, which is anonymous)
   PROMETHEUS_URL  staging Prometheus (required: without it the run cannot prove cl_waiting/fd, so it FAILS)
   REPORT_PATH     where handleSummary writes the JSON run report (required)
   BASELINE_RATE / BURST_RATE / FLOOD_RATE (req/s, defaults 60 / 500 / 5000) and
   BASELINE_DURATION / BURST_DURATION / FLOOD_DURATION (k6 durations, defaults 60s) override the scenario sizes (so the
   harness can run a tiny version against a mock).
 options.scenarios, all `constant-arrival-rate`, timeUnit 1s:
   baseline            authenticated staff traffic, rate <= 120 (TRD s14 sustained 60-120 req/s)
   burst               authenticated traffic at 500 req/s (PgBouncer cl_waiting probe), starts after baseline ends
   flood               ANONYMOUS traffic at FLOOD_RATE (5000) for FLOOD_DURATION (60 s), starts after burst ends
   staff_during_flood  authenticated staff probe, SAME startTime and duration as flood
 Prometheus (instant queries; the mock answers by substring of the `query` param): the run queries a PgBouncer waiting metric
   containing `pgbouncer_pools_client_waiting_connections` and an fd metric containing `node_filefd_allocated` (ratio to
   `node_filefd_maximum` may be computed in PromQL or in the script; the mock returns the ratio for any query containing
   `node_filefd`). Empty result = no evidence = FAIL.
 Burst must really arrive (review T-32 item 1): burst responses must be 200 (Rate `burst_ok`, threshold rate>0.99); a burst shed
   by the edge (429) means 500 req/s never reached PgBouncer, so cl_waiting==0 proves nothing -> FAIL.
 Report JSON keys: ac="AC-24.1", pass(bool), burst_ok_rate (fraction of burst responses with status 200), target_env, flood_rate, shed_responses (429+503 seen on flood traffic),
   staff_p95_baseline_ms, staff_p95_flood_ms, staff_p95_ratio, pgbouncer_cl_waiting_max, fd_used_ratio_max.
 pass = burst_ok_rate>0.99 AND shed_responses>0 AND ratio<2 AND cl_waiting_max==0 AND fd_used_ratio_max<0.9 [CONV]. k6 must exit NON-ZERO whenever
   pass is false (thresholds / abort), and exit 0 when true. 429/503 on flood traffic are expected, not failures.
"""
import json
import os
import re
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[3]
FLOOD = ROOT / "infra" / "tests" / "load" / "flood.js"
K6 = shutil.which("k6")
TOKEN = "synthetic-staff-token-t32"


def secs(v):
    """k6 duration (`1m0s`, `60s`, `2s`, `500ms`) or number of ms -> seconds."""
    if isinstance(v, (int, float)):
        return v / 1000.0
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?", v)
    assert m and v, "unparsable duration %r" % v
    h, mi, s, ms = m.groups()
    return int(h or 0) * 3600 + int(mi or 0) * 60 + float(s or 0) + int(ms or 0) / 1000.0


class Mock:
    """Target + Prometheus in one local server. Authorization == Bearer TOKEN -> staff (200 after STAFF_MS, +SLOW_MS while an
    anonymous flood was seen in the last second); anonymous -> `anon_status`. /api/v1/query -> canned Prometheus answers."""

    def __init__(self, anon_status=429, slow_ms=0, cl_waiting="0", fd="0.1", empty=False, auth_shed=None):
        self.auth_shed = auth_shed  # (lo, hi): authenticated request #n with lo < n <= hi gets 429 (sheds part of the burst)
        self.anon_status, self.slow_ms, self.cl_waiting, self.fd, self.empty = anon_status, slow_ms, cl_waiting, fd, empty
        self.anon = self.staff = self.bad_auth = 0
        self.queries = []
        self.last_anon = 0.0
        self.lock = threading.Lock()
        mock = self

        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _send(self, code, body=b"{}"):
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                u = urlparse(self.path)
                if u.path == "/api/v1/query":
                    q = parse_qs(u.query).get("query", [""])[0]
                    with mock.lock:
                        mock.queries.append(q)
                    val = mock.fd if "node_filefd" in q else mock.cl_waiting if "pgbouncer_pools_client_waiting_connections" in q else "0"
                    res = [] if mock.empty else [{"metric": {}, "value": [time.time(), val]}]
                    return self._send(200, json.dumps({"status": "success", "data": {"resultType": "vector", "result": res}}).encode())
                auth = self.headers.get("Authorization")
                if auth is None:
                    with mock.lock:
                        mock.anon += 1
                        mock.last_anon = time.time()
                    return self._send(mock.anon_status)
                if auth != "Bearer " + TOKEN:
                    with mock.lock:
                        mock.bad_auth += 1
                    return self._send(401)
                with mock.lock:
                    mock.staff += 1
                    n = mock.staff
                    flooding = time.time() - mock.last_anon < 1.0
                if mock.auth_shed and mock.auth_shed[0] < n <= mock.auth_shed[1]:
                    return self._send(429)
                time.sleep(0.05 + (mock.slow_ms / 1000.0 if flooding else 0))
                self._send(200)

            do_POST = do_GET

        class S(socketserver.ThreadingMixIn, HTTPServer):
            daemon_threads = True
            request_queue_size = 256

        self.srv = S(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *a):
        self.srv.shutdown()
        self.srv.server_close()


def k6_env(mock, report, **over):
    env = dict(os.environ, K6_NO_USAGE_REPORT="true", TARGET_URL=mock.url, TARGET_ENV="staging", STAFF_TOKEN=TOKEN,
               PROMETHEUS_URL=mock.url, REPORT_PATH=str(report), BASELINE_RATE="20", BURST_RATE="50", FLOOD_RATE="100",
               BASELINE_DURATION="2s", BURST_DURATION="2s", FLOOD_DURATION="3s")
    env.update(over)
    return {k: v for k, v in env.items() if v is not None}


def run_k6(mock, tmp, **over):
    report = Path(tmp) / "report.json"
    p = subprocess.run([K6, "run", "--quiet", str(FLOOD)], env=k6_env(mock, report, **over), capture_output=True, text=True,
                       timeout=120, cwd=tmp)
    rep = json.loads(report.read_text(encoding="utf-8")) if report.exists() else None
    return p, rep


class TestSource(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = FLOOD.read_text(encoding="utf-8") if FLOOD.exists() else None

    def setUp(self):
        self.assertIsNotNone(self.src, "infra/tests/load/flood.js missing (T-32)")

    def test_k6_script_shape(self):
        for needle in ("k6/http", "export const options", "handleSummary", "__ENV.TARGET_URL", "__ENV.TARGET_ENV",
                       "__ENV.STAFF_TOKEN", "__ENV.PROMETHEUS_URL", "__ENV.REPORT_PATH", "AC-24.1"):
            self.assertIn(needle, self.src)

    def test_staff_url_and_burst_ok_present(self):  # review T-32 items 1 and 2
        for needle in ("__ENV.STAFF_URL", "burst_ok", "burst_ok_rate"):
            self.assertIn(needle, self.src)

    def test_staging_only_guard_names_both_staging_profiles(self):
        self.assertIn("staging-lean", self.src)  # LD-45
        self.assertRegex(self.src, r"['\"]staging['\"]")

    def test_metrics_queried(self):
        for needle in ("pgbouncer_pools_client_waiting_connections", "node_filefd_allocated"):
            self.assertIn(needle, self.src)

    def test_no_secret_or_real_target_in_file(self):
        self.assertIsNone(re.search(r"eyJ[A-Za-z0-9_-]{20,}", self.src), "JWT literal")
        self.assertIsNone(re.search(r"Bearer\s+[A-Za-z0-9_-]{16,}", self.src), "bearer literal")
        self.assertIsNone(re.search(r"https?://(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}", self.src, re.I),
                          "hard-coded external URL: target must come from TARGET_URL")

    def test_init_does_not_throw_on_missing_env(self):
        # refusals belong in setup(); `k6 inspect` (and this suite) must work with no env
        self.assertNotRegex(self.src, r"(?m)^(?:throw|fail\()|^if\s*\(!?__ENV")


@unittest.skipUnless(K6, "k6 not on PATH")
class TestOptions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FLOOD.exists():
            cls.opts = None
            return
        env = {k: v for k, v in os.environ.items() if k not in ("TARGET_URL", "TARGET_ENV", "STAFF_TOKEN", "BASELINE_RATE",
               "BURST_RATE", "FLOOD_RATE", "BASELINE_DURATION", "BURST_DURATION", "FLOOD_DURATION")}
        env["K6_NO_USAGE_REPORT"] = "true"
        p = subprocess.run([K6, "inspect", str(FLOOD)], env=env, capture_output=True, text=True, timeout=60)
        cls.rc, cls.err = p.returncode, p.stderr
        cls.opts = json.loads(p.stdout) if p.returncode == 0 else None

    def setUp(self):
        self.assertTrue(FLOOD.exists(), "infra/tests/load/flood.js missing (T-32)")
        self.assertIsNotNone(self.opts, "k6 inspect failed with no env: %s" % self.err[-300:])
        self.sc = self.opts["scenarios"]

    def test_scenario_names(self):
        self.assertEqual({"baseline", "burst", "flood", "staff_during_flood"}, set(self.sc))

    def test_all_constant_arrival_rate_per_second(self):
        for n, s in self.sc.items():
            self.assertEqual("constant-arrival-rate", s["executor"], n)
            self.assertEqual(1.0, secs(s["timeUnit"]), n)

    def test_flood_is_5000_rps_for_60s(self):  # AC-24.1
        self.assertEqual(5000, self.sc["flood"]["rate"])
        self.assertEqual(60.0, secs(self.sc["flood"]["duration"]))

    def test_burst_is_500_rps(self):  # 02-TRD s17 PgBouncer row
        self.assertEqual(500, self.sc["burst"]["rate"])

    def test_baseline_is_realistic_sustained_rate(self):  # 04 s14: 60-120 req/s
        self.assertTrue(1 <= self.sc["baseline"]["rate"] <= 120)

    def test_staff_probe_runs_alongside_flood(self):
        f, s = self.sc["flood"], self.sc["staff_during_flood"]
        self.assertEqual(secs(f.get("startTime", 0)), secs(s.get("startTime", 0)))
        self.assertEqual(secs(f["duration"]), secs(s["duration"]))
        self.assertLess(s["rate"], f["rate"])

    def test_phases_are_sequential(self):
        st = lambda n: secs(self.sc[n].get("startTime", 0))
        end = lambda n: st(n) + secs(self.sc[n]["duration"])
        self.assertGreaterEqual(st("burst"), end("baseline"))
        self.assertGreaterEqual(st("flood"), end("burst"))

    def test_pool_can_sustain_flood_rate(self):
        self.assertGreaterEqual(self.sc["flood"]["maxVUs"], 500)


@unittest.skipUnless(K6, "k6 not on PATH")
class TestRun(unittest.TestCase):
    """Real k6 against a local mock (tiny rates via the env overrides). Proves the verdict logic, the guard and the report."""

    def setUp(self):
        self.assertTrue(FLOOD.exists(), "infra/tests/load/flood.js missing (T-32)")
        self.tmp = tempfile.mkdtemp(prefix="t32")
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)

    def run_case(self, mock_kw=None, **over):
        with Mock(**(mock_kw or {})) as m:
            p, rep = run_k6(m, self.tmp, **over)
            return p, rep, m

    def test_pass_run(self):
        p, rep, m = self.run_case()
        self.assertEqual(0, p.returncode, p.stderr[-800:])
        self.assertIsNotNone(rep, "no report written")
        self.assertEqual("AC-24.1", rep["ac"])
        self.assertIs(rep["pass"], True)
        self.assertEqual("staging", rep["target_env"])
        self.assertEqual(100, rep["flood_rate"])
        self.assertGreater(rep["shed_responses"], 0)
        self.assertLess(rep["staff_p95_ratio"], 2)
        self.assertEqual(0, rep["pgbouncer_cl_waiting_max"])
        self.assertLess(rep["fd_used_ratio_max"], 0.9)
        for k in ("staff_p95_baseline_ms", "staff_p95_flood_ms"):
            self.assertGreater(rep[k], 0)
        # traffic really happened: anonymous flood >> staff probe; burst traffic authenticated; no stray credentials
        self.assertGreater(m.anon, 100)
        self.assertGreater(m.staff, 50)
        self.assertEqual(0, m.bad_auth)
        qs = " ".join(m.queries)
        self.assertIn("pgbouncer_pools_client_waiting_connections", qs)
        self.assertIn("node_filefd_allocated", qs)

    def test_staging_lean_accepted(self):
        p, rep, _ = self.run_case(TARGET_ENV="staging-lean")
        self.assertEqual(0, p.returncode, p.stderr[-800:])
        self.assertEqual("staging-lean", rep["target_env"])

    def test_refuses_non_staging_before_any_request(self):
        for env in ("prod", "prod-lean", "dev", "production", "", None):
            with self.subTest(target_env=env):
                p, rep, m = self.run_case(TARGET_ENV=env)
                self.assertNotEqual(0, p.returncode)
                self.assertEqual(0, m.anon + m.staff + m.bad_auth + len(m.queries), "requests sent despite refusal")
                (Path(self.tmp) / "report.json").unlink(missing_ok=True)

    def test_refuses_without_token_or_target(self):
        for k in ("STAFF_TOKEN", "TARGET_URL"):
            with self.subTest(missing=k):
                p, rep, m = self.run_case(**{k: None})
                self.assertNotEqual(0, p.returncode)
                self.assertEqual(0, m.anon + m.staff + len(m.queries))

    def test_fails_when_nothing_is_shed(self):
        p, rep, _ = self.run_case(dict(anon_status=200))
        self.assertNotEqual(0, p.returncode)
        self.assertIs(rep["pass"], False)
        self.assertEqual(0, rep["shed_responses"])

    def test_503_counts_as_shed_and_passes(self):
        p, rep, _ = self.run_case(dict(anon_status=503))
        self.assertEqual(0, p.returncode, p.stderr[-800:])
        self.assertGreater(rep["shed_responses"], 0)

    def test_fails_when_staff_p95_doubles(self):
        p, rep, _ = self.run_case(dict(slow_ms=300))
        self.assertNotEqual(0, p.returncode)
        self.assertIs(rep["pass"], False)
        self.assertGreaterEqual(rep["staff_p95_ratio"], 2)

    def test_fails_when_pgbouncer_clients_waited(self):
        p, rep, _ = self.run_case(dict(cl_waiting="3"))
        self.assertNotEqual(0, p.returncode)
        self.assertIs(rep["pass"], False)
        self.assertEqual(3, rep["pgbouncer_cl_waiting_max"])

    def test_fails_when_fd_nearly_exhausted(self):
        p, rep, _ = self.run_case(dict(fd="0.99"))
        self.assertNotEqual(0, p.returncode)
        self.assertIs(rep["pass"], False)
        self.assertGreaterEqual(rep["fd_used_ratio_max"], 0.9)

    def test_fails_without_prometheus_evidence(self):
        p, rep, _ = self.run_case(PROMETHEUS_URL=None)
        self.assertNotEqual(0, p.returncode)
        (Path(self.tmp) / "report.json").unlink(missing_ok=True)
        p, rep, _ = self.run_case(dict(empty=True))
        self.assertNotEqual(0, p.returncode, "empty Prometheus result must not count as cl_waiting 0")
        if rep is not None:
            self.assertIsNot(rep.get("pass"), True)

    def test_pass_run_reports_burst_ok(self):
        p, rep, _ = self.run_case()
        self.assertEqual(0, p.returncode, p.stderr[-800:])
        self.assertGreater(rep["burst_ok_rate"], 0.99)

    def test_fails_when_burst_is_shed_by_edge(self):
        # review T-32 item 1: authenticated burst answered 429 -> 500 req/s never reached PgBouncer -> must not pass.
        # calibration (40) + baseline (~40) consume staff requests 1..~80; requests 85..150 (most of the 100-request burst) get 429.
        p, rep, _ = self.run_case(dict(auth_shed=(85, 150)))
        self.assertNotEqual(0, p.returncode)
        self.assertIsNotNone(rep, "no report written")
        self.assertIs(rep["pass"], False)
        self.assertLess(rep["burst_ok_rate"], 0.99)
        self.assertEqual(0, rep["pgbouncer_cl_waiting_max"])  # cl_waiting alone looks fine: only burst_ok catches it

    def test_staff_url_separates_authenticated_from_flood_traffic(self):
        # review T-32 item 2: flood (anonymous) -> TARGET_URL; calibration/baseline/burst/staff probe (bearer) -> STAFF_URL.
        with Mock() as flood_m, Mock() as staff_m:
            p, rep = run_k6(flood_m, self.tmp, STAFF_URL=staff_m.url, PROMETHEUS_URL=staff_m.url)
        self.assertEqual(0, p.returncode, p.stderr[-800:])
        self.assertIs(rep["pass"], True)
        self.assertGreater(flood_m.anon, 100)  # flood hit TARGET_URL
        self.assertEqual(0, flood_m.staff + flood_m.bad_auth)  # no bearer traffic on the flood address
        self.assertEqual(0, staff_m.anon)  # no anonymous flood on the staff address
        self.assertGreater(staff_m.staff, 150)  # calibration + baseline + burst + probe
        self.assertEqual(0, staff_m.bad_auth)


if __name__ == "__main__":
    unittest.main()
