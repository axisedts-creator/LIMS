#!/usr/bin/env python3
"""AC-01.1 / AC-01.2: external port scan of every public IP in the active inventory (02-TRD s18, monthly + every deploy).

Targets come from <inventory>/hosts.yml only (LD-45: lean and full both pass; no host name lives in this script).
A host in group `app` may accept tcp 80 and 443 and nothing else; every other host accepts nothing.
Scan: tcp --ports (default 1-65535) plus the 18 AC-01.2 ports, always; udp --udp-port (default 51820): any reply is a violation.
Positive control (fail closed): an app host must accept 80 or 443, else the vantage is blocked or the env is down -> exit 1.
Exit: 0 clean, 1 violation or failed control, 2 usage / unreadable inventory. Output: `VIOLATION <name> <ip> <port>/<proto>`.
"""
import argparse
import ipaddress
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import yaml

AC012 = [5432, 6432, 6543, 8000, 8443, 3000, 8080, 9999, 4000, 5433, 9090, 9093, 3100, 9428, 9464, 6379, 3310, 22]
WEB = (80, 443)


class Usage(Exception):
    pass


def safe(s):
    """Names come from data; keep the output line-oriented (no control chars, no spaces) so nothing forges a VIOLATION line."""
    return re.sub(r"[^\x21-\x7e]", "?", str(s))


def load_targets(inv):
    d = Path(inv)
    if not d.is_dir():
        raise Usage("inventory %s is not a directory" % inv)
    try:
        doc = yaml.safe_load((d / "hosts.yml").read_text(encoding="utf-8"))
        children = doc["all"]["children"]
        if not isinstance(children, dict):
            raise TypeError("all.children is not a mapping")
    except Exception as e:  # unreadable input must never look like a clean scan
        raise Usage("cannot read %s/hosts.yml: %s" % (inv, e))
    hosts = {}  # name -> {"ip": str|None, "app": bool}
    for g, body in children.items():
        for name, v in ((body or {}).get("hosts") or {}).items():
            h = hosts.setdefault(str(name), {"ip": None, "app": False})
            h["app"] = h["app"] or g == "app"
            ip = (v or {}).get("public_ip")
            if ip:
                if h["ip"] not in (None, str(ip)):
                    raise Usage("host %s has two different public_ip values" % safe(name))
                h["ip"] = str(ip)
    if not hosts:
        raise Usage("no hosts in %s/hosts.yml" % inv)
    for name, h in hosts.items():
        if not h["ip"]:
            raise Usage("host %s has no public_ip" % safe(name))
        try:
            ipaddress.ip_address(h["ip"])
        except ValueError:
            raise Usage("host %s: bad public_ip %s" % (safe(name), safe(h["ip"])))
    return dict(sorted(hosts.items()))


def parse_range(s):
    m = re.fullmatch(r"(\d{1,5})(?:-(\d{1,5}))?", s or "")
    if not m:
        raise Usage("bad --ports %r (want N or A-B, 1-65535)" % s)
    a = int(m.group(1))
    b = int(m.group(2) or a)
    if not 1 <= a <= b <= 65535:
        raise Usage("bad --ports %r (want 1 <= A <= B <= 65535)" % s)
    return a, b


def tcp_open(ip, port, timeout):
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def udp_replies(ip, port, timeout):
    """True only when the peer answers. ICMP unreachable / silence = closed or filtered = fine."""
    fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
    try:
        with socket.socket(fam, socket.SOCK_DGRAM) as s:
            s.settimeout(timeout)
            s.connect((ip, port))
            s.send(b"\x00" * 8)
            s.recv(2048)
            return True
    except OSError:
        return False


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--inventory", required=True)
    ap.add_argument("--ports", default="1-65535")
    ap.add_argument("--timeout", type=float, default=2.0)
    ap.add_argument("--udp-port", type=int, default=51820)
    ap.add_argument("--no-control", action="store_true")
    ap.add_argument("--list", action="store_true")
    try:
        a = ap.parse_args(argv)
        lo, hi = parse_range(a.ports)
        hosts = load_targets(a.inventory)
        if not 1 <= a.udp_port <= 65535 or a.timeout <= 0:
            raise Usage("bad --udp-port or --timeout")
    except Usage as e:
        print("ports.py: %s" % e, file=sys.stderr)
        return 2
    except SystemExit as e:
        return 2 if e.code else 0

    if a.list:
        for n, h in hosts.items():
            print("TARGET %s %s tcp-open=%s" % (safe(n), h["ip"], "80,443" if h["app"] else "none"))
        print("EXPLICIT " + ",".join(map(str, AC012)))
        return 0

    ports = sorted(set(range(lo, hi + 1)) | set(AC012))
    bad, control_ok = [], {}
    # ponytail: one thread pool of 400 over all connects; a 65535-port scan of a filtered host takes ports*timeout/400 s.
    with ThreadPoolExecutor(400) as ex:
        for n, h in hosts.items():
            ip = h["ip"]
            allowed = set(WEB) if h["app"] else set()
            opened = [p for p, o in zip(ports, ex.map(lambda p: tcp_open(ip, p, a.timeout), ports)) if o]
            bad += ["VIOLATION %s %s %d/tcp" % (safe(n), ip, p) for p in opened if p not in allowed]
            if udp_replies(ip, a.udp_port, a.timeout):
                bad.append("VIOLATION %s %s %d/udp" % (safe(n), ip, a.udp_port))
            if h["app"] and not a.no_control:
                control_ok[n] = any(p in opened if p in ports else tcp_open(ip, p, a.timeout) for p in WEB)
    for v in bad:
        print(v)
    failed = [n for n, ok in control_ok.items() if not ok]
    for n in failed:
        print("CONTROL-FAIL %s accepts neither tcp 80 nor 443: vantage blocked or env down, scan is not valid" % safe(n))
    print("scanned %d host(s), %d tcp port(s) each; %d violation(s)" % (len(hosts), len(ports), len(bad)))
    return 1 if bad or failed else 0


if __name__ == "__main__":
    sys.exit(main())
