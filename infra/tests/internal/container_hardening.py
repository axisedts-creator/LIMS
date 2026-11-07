#!/usr/bin/env python3
"""Check a Docker daemon.json against 02-TRD s5.7 (REQ-SEC-130). Stdlib only (runs on product hosts).

Usage: container_hardening.py --daemon-json PATH
Exit 0 = compliant; 1 = deviation (offending key named on stdout); 2 = unreadable/malformed file.
"""
import argparse
import json
import sys

EXPECT = {"log-driver": "json-file", "live-restore": True, "no-new-privileges": True,
          "icc": False, "userland-proxy": False}
LOG_OPTS = {"max-size": "50m", "max-file": "5"}
NOFILE = {"Name": "nofile", "Soft": 65536, "Hard": 65536}


def check(d):
    bad = []
    for k, v in EXPECT.items():
        if d.get(k) != v:
            bad.append(f"{k}: expected {v!r}, got {d.get(k)!r}")
    opts = d.get("log-opts")
    opts = opts if isinstance(opts, dict) else {}
    for k, v in LOG_OPTS.items():
        if opts.get(k) != v:
            bad.append(f"{k}: expected {v!r}, got {opts.get(k)!r}")
    ul = d.get("default-ulimits")
    nofile = ul.get("nofile") if isinstance(ul, dict) else None
    if nofile != NOFILE:
        bad.append(f"default-ulimits: nofile expected {NOFILE!r}, got {nofile!r}")
    hosts = d.get("hosts", [])
    if not isinstance(hosts, list) or any(not str(h).startswith(("unix://", "fd://")) for h in hosts):
        bad.append(f"hosts: only unix:// or fd:// allowed (no TCP API), got {hosts!r}")
    return bad


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon-json", required=True)
    path = ap.parse_args(argv).daemon_json
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if not isinstance(d, dict):
            raise ValueError("top level is not an object")
    except (OSError, ValueError) as e:
        print(f"FAIL cannot read {path}: {e}", file=sys.stderr)
        return 2
    bad = check(d)
    for b in bad:
        print(f"FAIL {b}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
