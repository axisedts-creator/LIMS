#!/usr/bin/env python3
"""US-04 edge limits on the live edge (02-TRD s6.5): AC-04.1, 04.2, 04.3, 04.3a, 04.8, 04.9, 04.10.

08 A27.2 test profile: the bursts below produce jail-countable rejections from one IP, so either each scenario runs
from a distinct source IP (LIMS_TEST_SOURCE_IPS = comma-separated local addresses to bind, one per scenario), or the
`lims-ratelimit` jail is disabled for the run and the operator says so (LIMS_RATELIMIT_JAIL_OFF=1). Neither = exit 2.
Also checks the UNVERIFIED point of 02-TRD s6.5: the location's `set $retry_after 60` is visible in @ratelimited.
Env: LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL, LIMS_ORIGIN_API (required), LIMS_EDGE_ADDR, LIMS_TLS_CA or
LIMS_TLS_INSECURE=1. `--slow` adds the evenly-spaced 60 s scenarios (AC-04.1 / AC-04.3 'none rejected').
"""
import http.client
import itertools
import json
import os
import socket
import ssl
import sys
import time
from concurrent.futures import ThreadPoolExecutor

AGENT_MAX = 4 * 1024 * 1024        # AC-04.3a: 4 MiB passes, 4 MiB + 1 byte -> 413
ATTACH_MAX = 16 * 1024 * 1024


def config():
    o = {k: os.environ.get("LIMS_ORIGIN_" + k.upper(), "") for k in ("staff_web", "portal", "api")}
    if not all(o.values()):
        sys.stderr.write("ratelimit.py: set LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL, LIMS_ORIGIN_API\n")
        sys.exit(2)
    ips = [x.strip() for x in os.environ.get("LIMS_TEST_SOURCE_IPS", "").split(",") if x.strip()]
    if not ips and os.environ.get("LIMS_RATELIMIT_JAIL_OFF") != "1":
        sys.stderr.write("ratelimit.py: 08 A27.2 - give distinct source IPs (LIMS_TEST_SOURCE_IPS) or confirm the "
                         "lims-ratelimit jail is off for this run (LIMS_RATELIMIT_JAIL_OFF=1)\n")
        sys.exit(2)
    return o, itertools.cycle(ips or [None])


def tls_ctx():
    if os.environ.get("LIMS_TLS_INSECURE") == "1":
        c = ssl.create_default_context()
        c.check_hostname, c.verify_mode = False, ssl.CERT_NONE
        return c
    return ssl.create_default_context(cafile=os.environ.get("LIMS_TLS_CA") or None)


def req(host, method, path, src=None, body=None, headers=None):
    ctx = tls_ctx()
    raw = socket.create_connection((os.environ.get("LIMS_EDGE_ADDR") or host, 443), 30, (src, 0) if src else None)
    c = http.client.HTTPSConnection(host, 443, context=ctx, timeout=30)
    c.sock = ctx.wrap_socket(raw, server_hostname=host)
    c.request(method, path, body=body, headers=dict({"Host": host}, **(headers or {})))
    r = c.getresponse()
    data = r.read()
    c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}, data


def otp_route_published():
    import yaml
    p = os.environ.get("LIMS_ROUTES_YAML") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "edge", "public-routes.yaml")
    with open(p, encoding="utf-8") as f:
        return any(r["path"].startswith("/v1/engagement/auth/otp-challenges") for r in yaml.safe_load(f)["routes"])


def burst(host, method, path, n, src):
    with ThreadPoolExecutor(min(n, 64)) as ex:
        return list(ex.map(lambda _: req(host, method, path, src), range(n)))


class Run:
    def __init__(self):
        self.fails = []

    def check(self, ok, what):
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            self.fails.append(what)

    def limited(self, label, res, want_429, retry_after):
        """want_429 +-1: the wall clock refills the bucket while the burst is in flight."""
        lim = [r for r in res if r[0] == 429]
        self.check(abs(len(lim) - want_429) <= 1, "%s: %d x 429 of %d (want %d)" % (label, len(lim), len(res), want_429))
        if want_429 and lim:
            self.check(lim[0][1].get("retry-after") == retry_after, "%s: Retry-After %r (want %s)" % (label, lim[0][1].get("retry-after"), retry_after))
            try:
                code = json.loads(lim[0][2]).get("code")
            except ValueError:
                code = None
            self.check(code == "common.rate_limited", "%s: 429 body code %r" % (label, code))


def main():
    o, src = config()
    slow = "--slow" in sys.argv
    t = Run()

    # AC-04.1 login flood guard (staff_web): 41 POST at once -> 21 pass, 20 x 429, Retry-After 60
    s = next(src)
    t.limited("AC-04.1 41 POST /auth/login", burst(o["staff_web"], "POST", "/auth/login", 41, s), 20, "60")
    time.sleep(2)
    res = burst(o["staff_web"], "GET", "/auth/login", 100, s)
    t.check(not [r for r in res if r[0] == 429], "AC-04.1 100 GET /auth/login: none rejected (only POSTs count)")

    # AC-04.2 QR verify: 11 GET /v/{token} at once -> the 11th is 429
    t.limited("AC-04.2 11 GET /v/", burst(o["portal"], "GET", "/v/abc", 11, next(src)), 1, "60")

    # AC-04.3a agent body limits (before the burst: the zone is checked before the body)
    s = next(src)
    big = b"x" * (AGENT_MAX + 1)
    t.check(req(o["api"], "POST", "/v1/instruments/agent/message-batches", s, big)[0] == 413, "AC-04.3a 4 MiB + 1 -> 413")
    t.check(req(o["api"], "POST", "/v1/instruments/agent/message-batches", s, big[:-1])[0] != 413, "AC-04.3a 4 MiB passes the edge")
    t.check(req(o["api"], "POST", "/v1/instruments/agent/attachments", s, b"x" * (ATTACH_MAX + 1))[0] == 413, "AC-04.3a attachments 16 MiB + 1 -> 413")
    t.check(req(o["api"], "POST", "/v1/instruments/agent/attachments", s, b"x" * (15 * 1000 * 1000 + 64 * 1024))[0] != 413, "AC-04.3a 15 MB + metadata passes")
    time.sleep(2)
    # AC-04.3 agent: 401 at once -> 201 pass, 200 x 429
    t.limited("AC-04.3 401 POST /v1/instruments/agent/", burst(o["api"], "POST", "/v1/instruments/agent/heartbeats", 401, s), 200, "60")

    # AC-04.8 payments: GET/HEAD only, no body, 10 r/s burst 20 (Retry-After default 1)
    s = next(src)
    for p in ("/v1/payments/result", "/v1/payments/launch/x", "/v1/payments/callbacks/khalti/x"):
        t.check(req(o["api"], "POST", p, s)[0] == 405, "AC-04.8 POST %s -> 405" % p)
        t.check(req(o["api"], "GET", p, s, b"x", {"Content-Length": "1"})[0] == 413, "AC-04.8 GET with body %s -> 413" % p)
        t.check(req(o["api"], "GET", p, s, b"1\r\nx\r\n0\r\n\r\n", {"Transfer-Encoding": "chunked"})[0] == 413, "AC-04.8 chunked GET %s -> 413" % p)
    time.sleep(3)
    t.limited("AC-04.8 41 GET /v1/payments/result", burst(o["api"], "GET", "/v1/payments/result", 41, s), 20, "1")

    # AC-04.9 provider-callbacks, AC-04.10 otp-challenges: 41 at once -> 21 pass
    t.limited("AC-04.9 41 POST provider-callbacks", burst(o["api"], "POST", "/v1/reporting/provider-callbacks/x", 41, next(src)), 20, "60")
    if otp_route_published():
        t.limited("AC-04.10 41 POST otp-challenges", burst(o["api"], "POST", "/v1/engagement/auth/otp-challenges", 41, next(src)), 20, "60")
    else:
        print("SKIP AC-04.10 (no otp-challenges route in public-routes.yaml; C16 not shipped)")

    if slow:  # evenly spaced over 60 s -> none rejected
        s = next(src)
        res = []
        for i in range(60):
            res.append(req(o["staff_web"], "POST", "/auth/login", s))
            time.sleep(1)
        t.check(not [r for r in res if r[0] == 429], "AC-04.1 60 POST /auth/login over 60 s: none rejected")
        s = next(src)
        res = []
        for i in range(600):
            res.append(req(o["api"], "POST", "/v1/instruments/agent/heartbeats", s))
            time.sleep(0.1)
        t.check(not [r for r in res if r[0] == 429], "AC-04.3 600 agent requests over 60 s: none rejected")

    print("ratelimit: %d failure(s)" % len(t.fails))
    return 1 if t.fails else 0


if __name__ == "__main__":
    sys.exit(main())
