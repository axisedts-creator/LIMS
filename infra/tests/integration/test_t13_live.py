"""T-13 live test (tester role): real nginx, real sockets. Only with LIMS_T13_LIVE=1 (docker + openssl on PATH).

Renders the committed sites (dev profile), makes throw-away ECDSA P-256 certs, runs `nginx -t` and a container from
LIMS_T13_NGINX_IMAGE (default nginx:stable; CI pins the digest), then replays the PRD scenarios over TLS. Upstreams are
unreachable on purpose: a request that passes the edge limits answers 502/504, one that is limited answers 429, so counting
429s measures the limit_req zones without any app. Source-IP caveat (08 A27.2): every request comes from one IP, so the
jail `lims-ratelimit` must not run in this container (it does not: fail2ban is host-side).
NOT run by the tester (no nginx here): proves nothing until executed on the dev VM. 'Unknown' marked in T-13-tests.md.
"""
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
NGX = ROOT / "infra" / "edge" / "nginx"
LIVE = os.environ.get("LIMS_T13_LIVE") == "1"
IMAGE = os.environ.get("LIMS_T13_NGINX_IMAGE", "nginx:stable")
HOSTS = {"staff_web": "lab.t13.test", "portal": "portal.t13.test", "api": "api.t13.test", "partner": "partner.t13.test"}
PORT = 18443


@unittest.skipUnless(LIVE, "set LIMS_T13_LIVE=1 (docker + openssl) to run the live edge test")
class LiveEdge(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="t13live"))
        conf = cls.tmp / "etc"
        (conf / "conf.d").mkdir(parents=True)
        shutil.copytree(NGX / "snippets", conf / "snippets")
        shutil.copy(NGX / "nginx.conf", conf / "nginx.conf")
        env = jinja2.Environment(undefined=jinja2.StrictUndefined)
        routes = yaml.safe_load((ROOT / "infra/edge/public-routes.yaml").read_text(encoding="utf-8"))["routes"]
        for n in ("staff_web", "portal", "partner", "api", "acme"):
            out = env.from_string((NGX / "sites" / ("%s.conf.j2" % n)).read_text(encoding="utf-8")).render(
                origins=HOSTS, partner_enabled=True, public_routes=routes, wg_ip="127.0.0.1", inventory_hostname="dev-1",
                groups={"ops": ["dev-1"]}, hostvars={"dev-1": {"wg_ip": "127.0.0.1"}})
            (conf / "conf.d" / ("%s.conf" % n)).write_text(out, encoding="utf-8")
        for h in HOSTS.values():
            d = cls.tmp / "certs" / h
            d.mkdir(parents=True)
            subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2",
                            "-subj", "/CN=" + h, "-addext", "subjectAltName=DNS:" + h, "-keyout", str(d / "privkey.pem"),
                            "-out", str(d / "fullchain.pem")], check=True, capture_output=True)
        (cls.tmp / "acme").mkdir()
        cls.run_args = ["docker", "run", "--rm", "-v", "%s:/etc/nginx/nginx.conf:ro" % (conf / "nginx.conf"),
                        "-v", "%s:/etc/nginx/snippets:ro" % (conf / "snippets"), "-v", "%s:/etc/nginx/conf.d:ro" % (conf / "conf.d"),
                        "-v", "%s:/etc/nginx/certs:ro" % (cls.tmp / "certs"), "-v", "%s:/var/www/acme:ro" % (cls.tmp / "acme")]
        for h in ("web", "portal", "partner", "api-a", "api-b"):
            cls.run_args += ["--add-host", "%s:127.0.0.1" % h]
        cls.cid = None

    @classmethod
    def tearDownClass(cls):
        if cls.cid:
            subprocess.run(["docker", "rm", "-f", cls.cid], capture_output=True)
        shutil.rmtree(cls.tmp, True)

    def test_00_nginx_t(self):  # done_when: nginx -t
        r = subprocess.run(self.run_args + [IMAGE, "nginx", "-t"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_01_start(self):
        r = subprocess.run(self.run_args[:2] + ["-d", "--name", "t13-edge", "-p", "127.0.0.1:%d:443" % PORT, "-p", "127.0.0.1:18080:80"]
                           + self.run_args[3:] + [IMAGE], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        type(self).cid = "t13-edge"
        time.sleep(2)

    def req(self, host, method, path, body=None, headers=None):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        c = http.client.HTTPSConnection("127.0.0.1", PORT, context=ctx, timeout=10)
        c.sock = ctx.wrap_socket(__import__("socket").create_connection(("127.0.0.1", PORT)), server_hostname=host)
        c.request(method, path, body=body, headers=dict({"Host": host}, **(headers or {})))
        r = c.getresponse()
        data = r.read()
        out = (r.status, {k.lower(): v for k, v in r.getheaders()}, data)
        c.close()
        return out

    def burst(self, host, method, path, n):
        with ThreadPoolExecutor(n) as ex:
            return list(ex.map(lambda _: self.req(host, method, path), range(n)))

    def test_10_headers_and_no_banner(self):  # AC-03.1, AC-03.3
        for h in HOSTS.values():
            s, hd, _ = self.req(h, "GET", "/storage/v1/object/x")
            self.assertEqual(s, 404, h)
            self.assertEqual(hd["strict-transport-security"], "max-age=63072000; includeSubDomains")
            self.assertEqual(hd["x-frame-options"], "DENY")
            self.assertNotRegex(hd.get("server", ""), r"\d")

    def test_11_login_flood(self):  # AC-04.1: 41 POST at once -> 21 pass / 20 x 429 + Retry-After 60 + body code
        res = self.burst(HOSTS["staff_web"], "POST", "/auth/login", 41)
        lim = [r for r in res if r[0] == 429]
        self.assertIn(len(lim), (19, 20, 21))  # +-1: wall clock refills 1 token/s
        self.assertEqual(lim[0][1]["retry-after"], "60")
        self.assertEqual(json.loads(lim[0][2])["code"], "common.rate_limited")
        time.sleep(1)
        self.assertEqual([r for r in self.burst(HOSTS["staff_web"], "GET", "/auth/login", 100) if r[0] == 429], [])

    def test_12_qr(self):  # AC-04.2
        res = self.burst(HOSTS["portal"], "GET", "/v/abc", 11)
        self.assertIn(len([r for r in res if r[0] == 429]), (1, 2))

    def test_13_payments(self):  # AC-04.8
        for p in ("/v1/payments/result", "/v1/payments/launch/x", "/v1/payments/callbacks/khalti/x"):
            self.assertEqual(self.req(HOSTS["api"], "POST", p)[0], 405, p)
            self.assertEqual(self.req(HOSTS["api"], "GET", p, body=b"x", headers={"Content-Length": "1"})[0], 413, p)
        s, hd, _ = self.req(HOSTS["api"], "GET", "/v1/payments/result")
        self.assertEqual(hd["referrer-policy"], "no-referrer")
        self.assertEqual(hd["cache-control"], "no-store")

    def test_14_agent_body_limits(self):  # AC-04.3a
        big = b"x" * (4 * 1024 * 1024 + 1)
        self.assertEqual(self.req(HOSTS["api"], "POST", "/v1/instruments/agent/message-batches", body=big)[0], 413)
        self.assertNotEqual(self.req(HOSTS["api"], "POST", "/v1/instruments/agent/message-batches", body=big[:-1])[0], 413)
        self.assertEqual(self.req(HOSTS["api"], "POST", "/v1/instruments/agent/attachments", body=b"x" * (16 * 1024 * 1024 + 1))[0], 413)

    def test_15_default_deny_and_identity(self):  # AC-06.1, AC-26.1
        for p in ("/", "/pg/", "/api/mcp", "/mcp", "/rest/v1/", "/graphql/v1", "/functions/v1/", "/auth/v1/", "/storage/v1/",
                  "/v1/identity/auth/login"):
            self.assertEqual(self.req(HOSTS["api"], "GET", p)[0], 404, p)

    def test_16_port80(self):  # AC-02.4
        c = http.client.HTTPConnection("127.0.0.1", 18080, timeout=10)
        c.request("GET", "/auth/login?x=1", headers={"Host": HOSTS["staff_web"]})
        r = c.getresponse()
        self.assertEqual(r.status, 301)
        self.assertTrue(r.getheader("Location").startswith("https://"))

    def test_17_log_has_template_not_token(self):  # AC-18.4
        self.req(HOSTS["portal"], "GET", "/r/SECRETTOKEN123?mobile=9800000000")
        time.sleep(1)
        log = subprocess.run(["docker", "exec", self.cid, "cat", "/var/log/nginx/access.json"], capture_output=True, text=True).stdout
        self.assertIn("/r/{token}", log)
        self.assertNotIn("SECRETTOKEN123", log)
        self.assertNotIn("9800000000", log)


if __name__ == "__main__":
    unittest.main()
