#!/usr/bin/env python3
"""AC-19.2 synthetic load probe (T-27, tester-owned): GET a URL at a steady rate for N seconds, count failures.

Usage: rotation_load.py --url URL [--duration 300] [--rps 5] [--timeout 5] [--ca-file PATH]
  stdout (one JSON line): {"total": N, "failed": M, "duration_s": D, "first_errors": ["..."]}
  exit 0  only if total > 0 and failed == 0        (zero failed requests, AC-19.2)
  exit 1  any request failed (non-2xx, timeout, connection error) or nothing was sent
  exit 2  bad arguments (non-http(s) URL, duration/rps/timeout out of range)
A failure is any response that is not 2xx (redirects are NOT followed), any timeout, any connection error.
Stdlib only. Sends no body, no credentials, no cookies; the URL is the only input (query string is not logged).
"""
import argparse
import json
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import ssl


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def probe(url, timeout, ctx):
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.HTTPSHandler(context=ctx))
    try:
        with opener.open(urllib.request.Request(url, method="GET"), timeout=timeout) as r:
            return None if 200 <= r.status < 300 else "HTTP %d" % r.status
    except urllib.error.HTTPError as e:
        return "HTTP %d" % e.code
    except Exception as e:  # timeout, refused, reset, TLS: all count as failed requests
        return type(e).__name__


def run(url, duration, rps, timeout, ca_file=None):
    ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    lock = threading.Lock()
    res = {"total": 0, "failed": 0, "errs": []}

    def one():
        err = probe(url, timeout, ctx)
        with lock:
            res["total"] += 1
            if err:
                res["failed"] += 1
                if len(res["errs"]) < 5:
                    res["errs"].append(err)

    t0, threads, n = time.monotonic(), [], 0
    while time.monotonic() - t0 < duration:
        th = threading.Thread(target=one, daemon=True)
        th.start()
        threads.append(th)
        n += 1
        delay = t0 + n / rps - time.monotonic()
        if delay > 0:
            time.sleep(delay)
    for th in threads:
        th.join(timeout + 5)
    stuck = sum(th.is_alive() for th in threads)  # a request that never returned is a failure too
    with lock:
        res["failed"] += stuck
        res["total"] += 0
    return {"total": res["total"] + stuck, "failed": res["failed"], "duration_s": round(time.monotonic() - t0, 1),
            "first_errors": res["errs"]}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--duration", type=float, default=300)
    ap.add_argument("--rps", type=float, default=5)
    ap.add_argument("--timeout", type=float, default=5)
    ap.add_argument("--ca-file")
    try:
        a = ap.parse_args(argv)
    except SystemExit:
        return 2
    if urllib.parse.urlsplit(a.url).scheme not in ("http", "https") or not urllib.parse.urlsplit(a.url).hostname:
        print("rotation_load: url must be http(s)://host/...", file=sys.stderr)
        return 2
    if not (0 < a.duration <= 3600 and 0 < a.rps <= 200 and 0 < a.timeout <= 60):
        print("rotation_load: duration 0..3600 s, rps 0..200, timeout 0..60 s", file=sys.stderr)
        return 2
    out = run(a.url, a.duration, a.rps, a.timeout, a.ca_file)
    print(json.dumps(out))
    return 0 if out["total"] > 0 and out["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
