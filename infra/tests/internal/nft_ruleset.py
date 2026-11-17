#!/usr/bin/env python3
"""AC-01.4: `nft list ruleset` of a host is default-deny and Docker cannot publish around it (02-TRD s5.5).

Usage: nft_ruleset.py --public-iface IF [--nginx-ip 172.30.10.10] [--file F|-]   (no --file: runs `nft list ruleset`)
Pass only when (a) a chain with `hook input` has `policy drop`, and (b) a DOCKER-USER chain reached by `jump|goto DOCKER-USER`
from a `hook forward` chain of the same table accepts on IF only `ip daddr <nginx-ip> tcp dport { 80, 443 }` (plus established
traffic), and a bare `iifname "IF" drop` follows that accept. Dockers own iptables-nft DOCKER-USER (just `return`) does not hide
a bad chain: one reached chain that meets (b) is enough, since a drop in any base chain drops the packet.
Exit: 0 ok, 1 `VIOLATION ...`, 2 usage / unreadable ruleset.
"""
import argparse
import ipaddress
import re
import subprocess
import sys

COUNTER = re.compile(r"\bcounter(?:\s+packets\s+\d+\s+bytes\s+\d+)?")
ESTABLISHED = re.compile(r"ct state (?:established,related|related,established) accept")


class Usage(Exception):
    pass


def parse(text):
    """-> {(table, chain): {"hook", "policy", "rules": [normalised rule strings]}}. Line based, one rule per line."""
    chains, stack, table = {}, [], None
    for raw in text.splitlines():
        line = re.sub(r"\s+", " ", re.sub(r'#.*$|\bcomment "[^"]*"', "", raw)).strip()
        if not line:
            continue
        if line == "}":
            if stack:
                stack.pop()
            continue
        opens = line.endswith("{") and line.count("{") == line.count("}") + 1
        if opens:
            words = line.split()
            if words[0] == "table" and len(words) >= 3:
                table = " ".join(words[1:-1])
                stack.append("table")
            elif words[0] == "chain" and table and len(words) >= 2:
                chains[(table, words[1])] = {"hook": None, "policy": None, "rules": []}
                stack.append(("chain", (table, words[1])))
            else:
                stack.append("other")  # set / map / flowtable body: not a rule list
            continue
        if stack and isinstance(stack[-1], tuple):
            c = chains[stack[-1][1]]
            if line.startswith("type "):
                m = re.search(r"\bhook (\w+)", line)
                c["hook"] = m.group(1) if m else None
                m = re.search(r"\bpolicy (\w+)", line)
                c["policy"] = m.group(1) if m else None
            else:
                c["rules"].append(re.sub(r"\s+", " ", COUNTER.sub("", line)).strip())
    return chains


def ports_of(s):
    return sorted(int(p) for p in re.findall(r"\d+", s))


def check_docker_user(rules, iface, nginx):
    """-> list of problems for one DOCKER-USER chain (empty = ok)."""
    out, nginx_at, drop_at = [], None, None
    drop = re.compile(r'iifname "%s" drop' % re.escape(iface))
    allow = re.compile(r'iifname "%s" ip daddr (\S+) tcp dport (?:\{ ([\d, ]+) \}|(\d+)) accept' % re.escape(iface))
    for i, r in enumerate(rules):
        if drop_at is None and drop.fullmatch(r):
            drop_at = i
            continue
        m = allow.fullmatch(r)
        if m:
            if m.group(1) == nginx and ports_of(m.group(2) or m.group(3)) == [80, 443]:
                nginx_at = i if nginx_at is None else nginx_at
            else:
                out.append("accept on %s is not %s tcp 80,443: %s" % (iface, nginx, r))
        elif (drop_at is None and r.endswith("accept") and not ESTABLISHED.fullmatch(r)) or \
                (re.search(r'\biifname "%s"' % re.escape(iface), r) and not r.endswith("drop")):
            out.append("rule can accept public traffic before the drop: %s" % r)
    if drop_at is None:
        out.append('no `iifname "%s" drop` in DOCKER-USER' % iface)
    if nginx_at is None:
        out.append("no `iifname %s ip daddr %s tcp dport { 80, 443 } accept` in DOCKER-USER" % (iface, nginx))
    elif drop_at is not None and nginx_at > drop_at:
        out.append("the nginx accept comes after the drop (never reached)")
    return out


def check(text, iface, nginx):
    chains = parse(text)
    if not chains:
        raise Usage("no table/chain found in the ruleset input")
    bad = []
    if not any(c["hook"] == "input" and c["policy"] == "drop" for c in chains.values()):
        bad.append("no chain with `hook input` has `policy drop`")
    reached = {}
    for (t, name), c in chains.items():
        if c["hook"] != "forward":
            continue
        for r in c["rules"]:
            m = re.fullmatch(r"(?:jump|goto) DOCKER-USER", r)
            if m and (t, "DOCKER-USER") in chains:
                reached[(t, "DOCKER-USER")] = chains[(t, "DOCKER-USER")]
    if not reached:
        bad.append("no DOCKER-USER chain is reached by jump/goto from a `hook forward` chain")
    else:
        results = {k: check_docker_user(v["rules"], iface, nginx) for k, v in reached.items()}
        if not any(not p for p in results.values()):
            for (t, _), probs in results.items():
                bad += ["table %s DOCKER-USER: %s" % (t, p) for p in probs]
    return bad


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--public-iface", required=True)
    ap.add_argument("--nginx-ip", default="172.30.10.10")
    ap.add_argument("--file")
    try:
        a = ap.parse_args(argv)
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,15}", a.public_iface):
            raise Usage("bad --public-iface")
        ipaddress.ip_address(a.nginx_ip)
        if a.file == "-":
            text = sys.stdin.read()
        elif a.file:
            text = open(a.file, encoding="utf-8").read()
        else:
            text = subprocess.run(["nft", "list", "ruleset"], capture_output=True, text=True, check=True, timeout=30).stdout
        bad = check(text, a.public_iface, a.nginx_ip)
    except SystemExit as e:
        return 2 if e.code else 0
    except (Usage, ValueError, OSError, subprocess.SubprocessError) as e:  # unreadable ruleset must never read as green
        print("nft_ruleset.py: %s" % e, file=sys.stderr)
        return 2
    for b in bad:
        print("VIOLATION " + b)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
