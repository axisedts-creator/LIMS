#!/usr/bin/env python3
"""AC-03.1, AC-03.3, AC-04.8 headers against the live edge (02-TRD s6.4).

Env: LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL, LIMS_ORIGIN_API (required), LIMS_ORIGIN_PARTNER (optional),
LIMS_EDGE_ADDR (optional connect IP; SNI/Host stay the origin), LIMS_TLS_CA (CA file) or LIMS_TLS_INSECURE=1.
Exit 0 only when every check passes; 2 when no target is configured (never passes on nothing).
"""
import http.client
import os
import re
import socket
import ssl
import sys

SEC = {
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "cross-origin-opener-policy": "same-origin",
}
PAYMENTS = {"referrer-policy": "no-referrer", "cache-control": "no-store"}
# app paths and nginx-made 404s alike: AC-03.1 is "any HTTPS response"
PATHS = ["/", "/storage/v1/object/x", "/rest/v1/", "/v1/unknown", "/mcp"]
PAYMENT_PATHS = ["/v1/payments/result", "/v1/payments/launch/x", "/v1/payments/callbacks/khalti/x"]


def origins():
    o = {k: os.environ.get("LIMS_ORIGIN_" + k.upper(), "") for k in ("staff_web", "portal", "api", "partner")}
    if not all(o[k] for k in ("staff_web", "portal", "api")):
        sys.stderr.write("headers.py: set LIMS_ORIGIN_STAFF_WEB, LIMS_ORIGIN_PORTAL, LIMS_ORIGIN_API\n")
        sys.exit(2)
    return {k: v for k, v in o.items() if v}


def tls_ctx():
    if os.environ.get("LIMS_TLS_INSECURE") == "1":
        c = ssl.create_default_context()
        c.check_hostname, c.verify_mode = False, ssl.CERT_NONE
        return c
    return ssl.create_default_context(cafile=os.environ.get("LIMS_TLS_CA") or None)


def get(host, path, method="GET"):
    ctx = tls_ctx()
    c = http.client.HTTPSConnection(host, 443, context=ctx, timeout=15)
    addr = os.environ.get("LIMS_EDGE_ADDR") or host
    c.sock = ctx.wrap_socket(socket.create_connection((addr, 443), 15), server_hostname=host)
    c.request(method, path, headers={"Host": host})
    r = c.getresponse()
    r.read()
    c.close()
    return r.status, {k.lower(): v for k, v in r.getheaders()}


def main():
    fails = []
    for name, host in origins().items():
        for path in PATHS + (PAYMENT_PATHS if name == "api" else []):
            status, h = get(host, path)
            want = dict(SEC, **PAYMENTS) if path in PAYMENT_PATHS else SEC
            for k, v in want.items():
                if h.get(k) != v:
                    fails.append("%s %s (%s): %s = %r, want %r" % (host, path, status, k, h.get(k), v))
            if "preload" in h.get("strict-transport-security", ""):
                fails.append("%s %s: HSTS preload (04 I6)" % (host, path))
            if re.search(r"\d", h.get("server", "")):  # AC-03.3: no Server version string
                fails.append("%s %s: Server header carries a version: %r" % (host, path, h["server"]))
            if "x-powered-by" in h:
                fails.append("%s %s: X-Powered-By present" % (host, path))
    for f in fails:
        print("FAIL " + f)
    print("headers: %d failure(s)" % len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
