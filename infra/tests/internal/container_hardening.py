#!/usr/bin/env python3
"""Check a Docker daemon.json against 02-TRD s5.7 (REQ-SEC-130). Stdlib only (runs on product hosts).

Usage: container_hardening.py --daemon-json PATH
       container_hardening.py --memory-budget --ram-gib N [--max-pct 85] COMPOSE.json...
Exit 0 = compliant; 1 = deviation (offending key/service named on stdout); 2 = usage error / unreadable / malformed file.

--memory-budget (T-14, LD-68; AC-30.1, LD-45): sum(mem_limit x deploy.replicas) over every service of every file
must be <= max-pct % of RAM, exact Fraction arithmetic. A service with no (or zero) limit is unbounded -> fail, named.
Files are JSON (`docker compose config --format json`); sizes are bytes or a docker string (512m, 1.5g).
"""
import argparse
import json
import re
import sys
from fractions import Fraction

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


UNITS = {"": 1, "b": 1, "k": 1024, "kb": 1024, "m": 1024 ** 2, "mb": 1024 ** 2, "g": 1024 ** 3, "gb": 1024 ** 3}


def to_bytes(v):
    """mem_limit value -> Fraction bytes; ValueError on garbage. 0 means unbounded."""
    if isinstance(v, bool) or not isinstance(v, (int, str)):
        raise ValueError(f"bad size {v!r}")
    if isinstance(v, int):
        return Fraction(v)
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]*)\s*", v)
    if not m or m.group(2).lower() not in UNITS:
        raise ValueError(f"bad size {v!r}")
    return Fraction(m.group(1)) * UNITS[m.group(2).lower()]


def memory_budget(files, ram_gib, max_pct):
    total, bad = Fraction(0), []
    for path in files:
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        svcs = doc.get("services") if isinstance(doc, dict) else None
        if not isinstance(svcs, dict):
            raise ValueError(f"{path}: no services mapping")
        for name, s in svcs.items():
            if not isinstance(s, dict):
                raise ValueError(f"{path}: service {name} is not an object")
            deploy = s.get("deploy") or {}
            lim = s.get("mem_limit")
            if lim is None:
                lim = ((deploy.get("resources") or {}).get("limits") or {}).get("memory")
            b = to_bytes(lim) if lim is not None else Fraction(0)
            rep = deploy.get("replicas", 1)
            if isinstance(rep, bool) or not isinstance(rep, int) or rep < 0:
                raise ValueError(f"{path}: service {name}: bad replicas {rep!r}")
            if b <= 0:
                bad.append(f"FAIL {path}: service {name} has no mem_limit (unbounded)")
            total += b * rep
    cap = Fraction(ram_gib) * 1024 ** 3 * Fraction(max_pct) / 100
    if total > cap:
        bad.append(f"FAIL memory budget {float(total / 1024 ** 3):.4f} GiB > {float(cap / 1024 ** 3):.4f} GiB "
                   f"({max_pct}% of {ram_gib} GiB)")
    return bad


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--daemon-json")
    ap.add_argument("--memory-budget", action="store_true")
    ap.add_argument("--ram-gib")
    ap.add_argument("--max-pct", default="85")
    ap.add_argument("files", nargs="*")
    a = ap.parse_args(argv)
    if a.memory_budget:
        try:
            ram, pct = Fraction(a.ram_gib or ""), Fraction(a.max_pct)
            if ram <= 0 or pct <= 0 or not a.files or a.daemon_json:
                raise ValueError("usage: --memory-budget --ram-gib N [--max-pct P] FILE...")
            bad = memory_budget(a.files, ram, pct)
        except (OSError, ValueError, ZeroDivisionError) as e:  # json.JSONDecodeError is a ValueError
            print(f"FAIL cannot check memory budget: {e}", file=sys.stderr)
            return 2
        for line in bad:
            print(line)
        return 1 if bad else 0
    if not a.daemon_json or a.files:
        ap.error("--daemon-json PATH is required (or --memory-budget)")
    path = a.daemon_json
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
