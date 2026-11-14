#!/usr/bin/env python3
"""AC-01.3 / 07-SEC: every published port of a compose project binds an explicit host IP.

Input : one or more `docker compose config` outputs (YAML or --format json), or "-" for stdin.
Rule  : host_ip must be 127.0.0.1 or --wg-ip. Only exception: tcp 80/443 of service --nginx-service
        (default "nginx") on --public-ip. Anything else is a violation: no host_ip (= 0.0.0.0),
        0.0.0.0, ::, a bare container port (random host port on 0.0.0.0), network_mode: host.
Exit  : 0 ok, 1 violation(s), 2 usage / unreadable input. Prints one `VIOLATION ...` line each.
"""
import argparse
import re
import sys

import yaml

LOOPBACK = "127.0.0.1"


def _short(spec):
    """'[ip:]published:target[/proto]' -> dict like the long syntax; no published part -> no key."""
    s = str(spec)
    proto = "tcp"
    if "/" in s:
        s, proto = s.rsplit("/", 1)
    m = re.match(r"^\[([^\]]+)\]:(.*)$", s)  # [::1]:80:80
    if m:
        ip, rest = m.group(1), m.group(2)
        parts = rest.split(":")
    else:
        parts = s.split(":")
        ip = None
        if len(parts) == 3:
            ip, parts = parts[0], parts[1:]
    d = {"protocol": proto, "target": parts[-1]}
    if len(parts) == 2 and parts[0] != "":
        d["published"] = parts[0]
    if ip:
        d["host_ip"] = ip
    return d


def check(config, wg_ip, public_ip=None, nginx_service="nginx", only=None):
    out = []
    for name, svc in sorted((config.get("services") or {}).items()):
        if only is not None and name not in only:
            continue
        svc = svc or {}
        if svc.get("network_mode") == "host":
            out.append("%s: network_mode host publishes every port" % name)
        for p in svc.get("ports") or []:
            p = _short(p) if not isinstance(p, dict) else p
            ip = str(p.get("host_ip") or "")
            pub = str(p.get("published") or "")
            desc = "%s: %s:%s->%s/%s" % (name, ip or "<no host ip>", pub or "<random>", p.get("target"),
                                        p.get("protocol", "tcp"))
            if ip in (LOOPBACK, wg_ip) and wg_ip:
                continue
            if (public_ip and ip == public_ip and name == nginx_service and pub in ("80", "443")
                    and p.get("protocol", "tcp") == "tcp"):
                continue
            out.append(desc)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--wg-ip", required=True)
    ap.add_argument("--public-ip")
    ap.add_argument("--nginx-service", default="nginx")
    ap.add_argument("--only", help="comma list: check just these services (the ones `up` starts)")
    ap.add_argument("files", nargs="+")
    try:
        a = ap.parse_args(argv)
    except SystemExit as e:
        return 2 if e.code else 0
    only = set(a.only.split(",")) if a.only else None
    bad = []
    for f in a.files:
        try:
            text = sys.stdin.read() if f == "-" else open(f, encoding="utf-8").read()
            cfg = yaml.safe_load(text)
            if not isinstance(cfg, dict) or "services" not in cfg:
                raise ValueError("no services: key")
        except Exception as e:  # unreadable input must never look like "no violations"
            print("ERROR %s: %s" % (f, e), file=sys.stderr)
            return 2
        bad += ["%s %s" % (f, v) for v in check(cfg, a.wg_ip, a.public_ip, a.nginx_service, only)]
    for v in bad:
        print("VIOLATION " + v)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
