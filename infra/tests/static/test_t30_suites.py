"""T-30 tests (tester role): external/internal suites complete + monthly external scan timer (AC-01.1..AC-01.4).

Covers 06-PLAN row T-30 (done_when: `run.sh` all green on staging and prod; monthly scan timer on ops-1), 01-PRD AC-01.1..01.4,
07-SECURITY s5 (external port scan "every deploy + monthly"; the internal rows whose files are still missing), 02-TRD s2 tree
(external/{ports.py,...}, internal/{oncall_sudo.sh,auth_net.sh,roles.sql,...}) and s18 ("from ops-1 public interface ... monthly,
recorded"). LD-45 (2026-11-07, A34 lean hosting): host names/counts come from the ACTIVE INVENTORY PROFILE, never from the
script; lean (prod-1 + backup-1) and full (4 hosts) must both pass.

NOT provable here (no VM, no public network, no postgres, no docker, no systemd): a real scan of a deployed env, a real
`nft list ruleset`, running roles.sql, a real timer firing. The live checks are infra/tests/integration/test_t30_live.py
(LIMS_T30_LIVE=1, never run by the tester). These tests prove behaviour of the scanner/checker CLIs against local sockets and
fixtures, and the structure of the other artefacts.

CONTRACTS where the spec is silent (the writer meets them; a change goes through a dispute, not a silent edit):
 * infra/tests/external/ports.py (stdlib + PyYAML; AC-01.1, AC-01.2). `ports.py --inventory <dir> [--ports A-B] [--timeout S]
   [--udp-port N] [--no-control] [--list]`. Reads <dir>/hosts.yml; every host of every group, `public_ip` merged across the
   groups the host is in (a lean host is in data+app+ops and carries its vars in one of them), de-duplicated. A host in group
   `app` must accept tcp 80 and 443 and nothing else; every other host accepts nothing. Group name `app`, never host names.
   `--list` prints, without touching the network, one line per host `TARGET <name> <public_ip> tcp-open=<80,443|none>` and one
   line `EXPLICIT <p,p,...>` holding the 18 ports of AC-01.2; exit 0. Scan: default range 1-65535, `--ports` narrows it, but
   the AC-01.2 ports are ALWAYS probed too. A TCP connect that succeeds on an unexpected port -> `VIOLATION <name> <ip> <port>/tcp`
   and exit 1. UDP (default port 51820, `--udp-port` overrides): a datagram is sent; ANY reply datagram -> `VIOLATION ... /udp`;
   silence = open|filtered = fine. Fail closed: the positive control (an app host must accept 80 or 443, else the vantage is
   blocked/the env is down -> exit 1) is on unless `--no-control`. Exit 2 and a stderr message for: unreadable/missing hosts.yml,
   not a directory, no hosts, a host without public_ip, a bad `--ports`. 0 only when nothing is wrong.
 * infra/tests/internal/nft_ruleset.py (AC-01.4). `nft_ruleset.py --public-iface IF [--nginx-ip 172.30.10.10] [--file F|-]`;
   without --file it runs `nft list ruleset`. Passes (exit 0) only when (a) a chain with `hook input` has `policy drop`, and
   (b) a chain named DOCKER-USER, reached by `jump|goto DOCKER-USER` from a `hook forward` chain of the same table, drops
   everything arriving on IF (`iifname "IF" ... drop`, counters allowed) and the only accept on IF is to the nginx container on
   tcp 80/443 (written `ip daddr <nginx-ip> tcp dport { 80, 443 }`), and that accept precedes the drop. Else `VIOLATION ...`, exit 1;
   unreadable ruleset / missing --public-iface -> exit 2.
 * infra/tests/internal/{oncall_sudo.sh,auth_net.sh,roles.sql}: must exist, bash scripts parse (`bash -n`) with LF endings and
   sibling conventions (shebang, `set -u`, probe_lib.sh TAP); contents below in InternalSuiteComplete.
 * infra/tests/run.sh: no argument = today's T-01 gate (unchanged, other tests pin it). `run.sh all` requires LIMS_ENV in
   {staging, prod}; otherwise exit 2 with a message naming LIMS_ENV BEFORE any step runs. An unknown mode exits 2. `all` runs the
   whole static suite and the live external + internal scripts, so it names (or globs) every file under tests/external and
   tests/internal (quarterly oncall_sudo.sh may be excluded by an explicit comment `# quarterly`).
 * Scan timer: files `lims-external-scan.service` + `lims-external-scan.timer` (a `.j2` suffix allowed) anywhere under infra/
   (not tests/). Service: Type=oneshot, ExecStart runs tests/external/ports.py with --inventory, TimeoutStartSec <= 6 h, and the
   outcome is recorded through infra/ci/ops-note.sh (02-TRD s18 "recorded"). Timer: OnCalendar once a month (`monthly` or a
   `*-*-DD` calendar), Persistent=true, WantedBy=timers.target. Installed + enabled by an Ansible task (systemd enabled) that runs
   on group `ops` (lean = the one prod host) and is reachable from site.yml (role listed there, or a play of site.yml).
Stdlib + PyYAML. Missing file = FAIL (never skip). Run from repo root:
  python -B -m unittest discover -s infra/tests/static -p "test_t30_*.py" -v
"""
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
EXT = INFRA / "tests" / "external"
INT = INFRA / "tests" / "internal"
PORTS = EXT / "ports.py"
NFT = INT / "nft_ruleset.py"
RUN_SH = INFRA / "tests" / "run.sh"
INVS = INFRA / "ansible" / "inventories"
AC012 = [5432, 6432, 6543, 8000, 8443, 3000, 8080, 9999, 4000, 5433, 9090, 9093, 3100, 9428, 9464, 6379, 3310, 22]
HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|staging-a|staging-b|dev-1)\b")
BASH = shutil.which("bash") or r"C:\Program Files\Git\bin\bash.exe"


def read(p):
    if not Path(p).is_file():
        raise AssertionError("missing file %s" % Path(p).relative_to(ROOT).as_posix())
    return Path(p).read_text(encoding="utf-8")


def run(argv, cwd=ROOT, env=None, timeout=120, stdin=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, env=e, timeout=timeout, input=stdin)


def py(script, *args, **kw):
    if not Path(script).is_file():
        raise AssertionError("missing file %s" % Path(script).relative_to(ROOT).as_posix())
    return run([sys.executable, "-B", str(script), *args], **kw)


def write_inv(d, hosts):
    """hosts: {name: (group_list, public_ip or None)} -> <d>/hosts.yml in the repo's shape (vars on the first group only)."""
    groups = {}
    for name, (gs, ip) in hosts.items():
        for i, g in enumerate(gs):
            groups.setdefault(g, {})[name] = ({"public_ip": ip, "wg_ip": "10.1.0.1", "ansible_host": "10.1.0.1"}
                                              if (i == 0 and ip) else None)
    inv = {"all": {"children": {g: {"hosts": h} for g, h in groups.items()}}}
    Path(d).mkdir(parents=True, exist_ok=True)
    (Path(d) / "hosts.yml").write_text(yaml.safe_dump(inv), encoding="utf-8")
    return str(d)


def listen(ip, port=0, kind=socket.SOCK_STREAM):
    s = socket.socket(socket.AF_INET, kind)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1) if kind == socket.SOCK_STREAM else None
    s.bind((ip, port))
    if kind == socket.SOCK_STREAM:
        s.listen(16)
    return s


def violations(r):
    return [l for l in r.stdout.splitlines() if l.startswith("VIOLATION")]


# ================================================================ ports.py (AC-01.1, AC-01.2)
class PortsList(unittest.TestCase):
    def test_script_exists(self):
        self.assertTrue(PORTS.is_file(), "infra/tests/external/ports.py missing (AC-01.1 names it)")

    def test_every_profile_targets_come_from_inventory(self):  # LD-45: lean and full both pass; no literal host names
        found = [d for d in ("prod", "prod-lean", "staging", "staging-lean", "dev") if (INVS / d / "hosts.yml").is_file()]
        self.assertGreaterEqual(len(found), 4, "expected prod, prod-lean, staging, staging-lean inventories: %s" % found)
        for name in found:
            with self.subTest(inventory=name):
                inv = yaml.safe_load(read(INVS / name / "hosts.yml"))["all"]["children"]
                ips, app = {}, set()
                for g, body in inv.items():
                    for h, v in ((body or {}).get("hosts") or {}).items():
                        if v and v.get("public_ip"):
                            ips[h] = v["public_ip"]
                        if g == "app":
                            app.add(h)
                r = py(PORTS, "--inventory", str(INVS / name), "--list")
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                rows = {}
                for l in r.stdout.splitlines():
                    m = re.fullmatch(r"TARGET (\S+) (\S+) tcp-open=(\S+)", l.strip())
                    if m:
                        rows.setdefault(m.group(1), []).append((m.group(2), m.group(3)))
                self.assertEqual(set(rows), set(ips), "targets must be exactly the inventory hosts")
                for h, lst in rows.items():
                    self.assertEqual(len(lst), 1, "host %s listed more than once (merge its groups)" % h)
                    self.assertEqual(lst[0][0], ips[h])
                    self.assertEqual(lst[0][1], "80,443" if h in app else "none", h)

    def test_names_are_not_hardcoded(self):  # only group `app` accepts 80/443
        with tempfile.TemporaryDirectory() as d:
            inv = write_inv(Path(d) / "i", {"zeta-9": (["app", "ops"], "127.0.0.1"), "omega-3": (["backup"], "127.0.0.2"),
                                            "kappa-5": (["data"], "127.0.0.3")})
            r = py(PORTS, "--inventory", inv, "--list")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertIn("TARGET zeta-9 127.0.0.1 tcp-open=80,443", r.stdout)
            self.assertIn("TARGET omega-3 127.0.0.2 tcp-open=none", r.stdout)
            self.assertIn("TARGET kappa-5 127.0.0.3 tcp-open=none", r.stdout)

    def test_explicit_ac012_ports_listed(self):
        r = py(PORTS, "--inventory", str(INVS / "prod-lean"), "--list")
        m = re.search(r"(?m)^EXPLICIT (\S+)$", r.stdout)
        self.assertIsNotNone(m, r.stdout + r.stderr)
        self.assertEqual(sorted(int(x) for x in m.group(1).split(",")), sorted(AC012))

    def test_script_has_no_literal_host_names_in_code(self):
        code = "\n".join(l for l in read(PORTS).splitlines() if not l.lstrip().startswith("#"))
        code = re.sub(r'(?s)""".*?"""', "", code, count=1)  # the module docstring may quote the spec
        self.assertEqual(HOSTNAMES.findall(code), [], "host names/counts come from the inventory profile (LD-45)")


class PortsInputErrors(unittest.TestCase):  # fail closed: a bad input is exit 2, never a green scan
    def exit2(self, *args):
        r = py(PORTS, *args)
        self.assertEqual(r.returncode, 2, "args %s -> %s\n%s%s" % (args, r.returncode, r.stdout, r.stderr))
        self.assertTrue(r.stderr.strip(), "exit 2 needs a stderr message")

    def test_missing_inventory_dir(self):
        self.exit2("--inventory", str(ROOT / "no-such-inventory"), "--list")

    def test_inventory_is_a_file_not_dir(self):
        self.exit2("--inventory", str(INVS / "prod" / "hosts.yml"), "--list")

    def test_no_arguments(self):
        self.exit2()

    def test_unparsable_hosts_yml(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hosts.yml").write_text("all: [unclosed\n  - : :\n", encoding="utf-8")
            self.exit2("--inventory", d, "--list")

    def test_no_hosts(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "hosts.yml").write_text("all:\n  children:\n    app: {}\n", encoding="utf-8")
            self.exit2("--inventory", d)

    def test_host_without_public_ip(self):
        with tempfile.TemporaryDirectory() as d:
            inv = write_inv(Path(d) / "i", {"a-1": (["app"], "127.0.0.1"), "b-1": (["data"], None)})
            self.exit2("--inventory", inv, "--no-control", "--ports", "1-2")

    def test_bad_port_range(self):
        with tempfile.TemporaryDirectory() as d:
            inv = write_inv(Path(d) / "i", {"a-1": (["app"], "127.0.0.1")})
            for bad in ("0-5", "70000-70001", "9-3", "x", ""):
                self.exit2("--inventory", inv, "--no-control", "--ports", bad)


class PortsScan(unittest.TestCase):
    """Real sockets on 127.0.0.x. A closed loopback port refuses at once, so narrow --ports keeps this fast."""

    busy = None

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.socks = []
        self.addCleanup(lambda: [s.close() for s in self.socks])
        self.inv = write_inv(Path(self.tmp.name) / "i", {"web-x": (["app", "ops"], "127.0.0.1"), "bk-y": (["backup"], "127.0.0.2")})
        if PortsScan.busy is None:  # once per run; the AC-01.2 ports are always probed, a local service on one colours every case
            from concurrent.futures import ThreadPoolExecutor

            def up(t):
                with socket.socket() as c:
                    c.settimeout(3)
                    return t if c.connect_ex(t) == 0 else None

            with ThreadPoolExecutor(36) as ex:
                PortsScan.busy = [t for t in ex.map(up, [(ip, p) for ip in ("127.0.0.1", "127.0.0.2") for p in AC012]) if t]
        if PortsScan.busy:
            self.skipTest("local service already listens on %s (an AC-01.2 port)" % PortsScan.busy)

    def open_tcp(self, ip, port=0):
        s = listen(ip, port)
        self.socks.append(s)
        return s.getsockname()[1]

    def scan(self, ports, *extra, udp_port="9"):
        return py(PORTS, "--inventory", self.inv, "--ports", ports, "--timeout", "1", "--udp-port", udp_port, *extra)

    def test_clean_scan_passes(self):
        r = self.scan("20000-20003", "--no-control")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(violations(r), [])

    def test_unexpected_open_port_on_app_host_fails(self):  # AC-01.1: only 80/443 may accept
        p = self.open_tcp("127.0.0.1")
        r = self.scan("%d-%d" % (p, p), "--no-control")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        v = violations(r)
        self.assertTrue(any("web-x" in l and "127.0.0.1" in l and ("%d/tcp" % p) in l for l in v), r.stdout)

    def test_open_port_on_non_app_host_fails(self):  # the backup/data host accepts nothing at all
        p = self.open_tcp("127.0.0.2")
        r = self.scan("%d-%d" % (p, p), "--no-control")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(any("bk-y" in l and ("%d/tcp" % p) in l for l in violations(r)), r.stdout)
        self.assertFalse(any("web-x" in l for l in violations(r)), "a port open only on bk-y must not blame web-x")

    def test_explicit_ac012_ports_probed_even_with_narrow_range(self):  # AC-01.2
        port = None
        for cand in (9999, 4000, 8080, 5433, 9090, 9093, 3100, 9428, 9464, 6543, 8443, 3000):
            try:
                self.open_tcp("127.0.0.1", cand)
                port = cand
                break
            except OSError:
                continue
        if port is None:
            self.skipTest("none of the AC-01.2 ports could be bound locally")
        r = self.scan("1-2", "--no-control")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(any(("%d/tcp" % port) in l for l in violations(r)), r.stdout)

    def test_positive_control_blocks_a_false_green(self):  # all-closed from a blocked vantage must not read as "secure"
        r = self.scan("20000-20003")
        self.assertEqual(r.returncode, 1, "app host accepts neither 80 nor 443: the scan is invalid\n" + r.stdout + r.stderr)

    def test_80_and_443_on_app_host_are_allowed(self):
        try:
            self.open_tcp("127.0.0.1", 80)
            self.open_tcp("127.0.0.1", 443)
        except OSError:
            self.skipTest("cannot bind 127.0.0.1:80/443 here (needs privileges or the ports are taken)")
        for rng in ("80-80", "443-443"):  # narrow: other local services (e.g. Windows RPC on 135) must not colour the result
            r = self.scan(rng)
            self.assertEqual(r.returncode, 0, rng + "\n" + r.stdout + r.stderr)
            self.assertEqual(violations(r), [])

    def test_80_on_non_app_host_fails(self):
        try:
            self.open_tcp("127.0.0.1", 80)
            self.open_tcp("127.0.0.2", 80)
        except OSError:
            self.skipTest("cannot bind :80 on loopback here")
        r = self.scan("80-80")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(any("bk-y" in l and "80/tcp" in l for l in violations(r)), r.stdout)

    def test_udp_reply_is_a_violation(self):  # WireGuard must never answer an unauthenticated packet
        u = listen("127.0.0.1", 0, socket.SOCK_DGRAM)
        self.socks.append(u)
        port = u.getsockname()[1]
        stop = threading.Event()

        def echo():
            u.settimeout(0.2)
            while not stop.is_set():
                try:
                    data, addr = u.recvfrom(2048)
                    u.sendto(b"reply" + data[:4], addr)
                except OSError:
                    pass

        t = threading.Thread(target=echo, daemon=True)
        t.start()
        self.addCleanup(lambda: (stop.set(), t.join(2)))
        r = self.scan("20000-20001", "--no-control", udp_port=str(port))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(any("web-x" in l and "/udp" in l for l in violations(r)), r.stdout)

    def test_silent_udp_socket_reads_open_or_filtered(self):
        u = listen("127.0.0.1", 0, socket.SOCK_DGRAM)  # bound, never replies
        self.socks.append(u)
        r = self.scan("20000-20001", "--no-control", udp_port=str(u.getsockname()[1]))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_output_is_data_only_no_host_values_evaluated(self):  # a hostile inventory name must not break/forge output
        inv = write_inv(Path(self.tmp.name) / "j", {"evil\nVIOLATION forged 1.2.3.4 1/tcp": (["app"], "127.0.0.1")})
        r = py(PORTS, "--inventory", inv, "--ports", "20000-20001", "--no-control", "--timeout", "1", "--udp-port", "9")
        self.assertFalse(any(l.startswith("VIOLATION forged") for l in r.stdout.splitlines()), "forged line in output")


# ================================================================ nft_ruleset.py (AC-01.4)
GOOD = """table inet filter {
\tset wg_peers {
\t\ttype ipv4_addr
\t\tflags interval
\t\telements = { 198.51.100.41, 192.0.2.11 }
\t}
\tchain input {
\t\ttype filter hook input priority filter; policy drop;
\t\tct state established,related accept
\t\tct state invalid drop
\t\tiif "lo" accept
\t\tudp dport 51820 ip saddr @wg_peers accept
\t\tiifname "eth0" tcp dport { 80, 443 } accept
\t\tiifname "wg0" jump wg_in
\t}
\tchain wg_in {
\t\ttcp dport 22 ip saddr { 10.77.0.41 } accept
\t}
\tchain forward {
\t\ttype filter hook forward priority filter - 10; policy accept;
\t\tjump DOCKER-USER
\t}
\tchain DOCKER-USER {
\t\tct state established,related accept
\t\tiifname "eth0" ip daddr 172.30.10.10 tcp dport { 80, 443 } counter packets 3 bytes 180 accept
\t\tiifname "eth0" counter packets 7 bytes 420 drop
\t\tip saddr 172.30.50.0/24 drop
\t}
}
"""


def mut(old, new, text=GOOD):
    assert old in text, old
    return text.replace(old, new)


class NftRuleset(unittest.TestCase):
    def check(self, text, *extra, iface="eth0"):
        return py(NFT, "--public-iface", iface, "--file", "-", *extra, stdin=text)

    def test_good_ruleset_passes(self):
        r = self.check(GOOD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(violations(r), [])

    def test_good_ruleset_from_file_arg(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "rules.nft"
            f.write_text(GOOD, encoding="utf-8")
            r = py(NFT, "--public-iface", "eth0", "--file", str(f))
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_input_policy_accept_fails(self):
        r = self.check(mut("priority filter; policy drop;", "priority filter; policy accept;"))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(violations(r))

    def test_input_policy_missing_fails(self):  # nft default is accept
        r = self.check(mut("type filter hook input priority filter; policy drop;", "type filter hook input priority filter;"))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_policy_drop_on_a_non_input_chain_does_not_count(self):
        t = mut("hook input priority filter; policy drop;", "hook input priority filter; policy accept;")
        t = mut("hook forward priority filter - 10; policy accept;", "hook forward priority filter - 10; policy drop;", t)
        self.assertEqual(self.check(t).returncode, 1)

    def test_docker_user_without_public_drop_fails(self):
        r = self.check(mut('\t\tiifname "eth0" counter packets 7 bytes 420 drop\n', ""))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)

    def test_public_accept_without_nginx_restriction_fails(self):
        t = mut('iifname "eth0" ip daddr 172.30.10.10 tcp dport { 80, 443 } counter packets 3 bytes 180 accept',
                'iifname "eth0" accept')
        self.assertEqual(self.check(t).returncode, 1)

    def test_nginx_accept_on_extra_port_fails(self):
        t = mut("ip daddr 172.30.10.10 tcp dport { 80, 443 }", "ip daddr 172.30.10.10 tcp dport { 22, 80, 443 }")
        self.assertEqual(self.check(t).returncode, 1)

    def test_accept_to_other_container_fails(self):
        t = mut("ip daddr 172.30.10.10 tcp dport { 80, 443 }", "ip daddr 172.30.50.20 tcp dport { 80, 443 }")
        self.assertEqual(self.check(t).returncode, 1)

    def test_drop_before_nginx_accept_fails(self):  # the accept would never be reached; the allow-list is not what it says
        a = '\t\tiifname "eth0" ip daddr 172.30.10.10 tcp dport { 80, 443 } counter packets 3 bytes 180 accept\n'
        b = '\t\tiifname "eth0" counter packets 7 bytes 420 drop\n'
        self.assertEqual(self.check(mut(a + b, b + a)).returncode, 1)

    def test_unreferenced_docker_user_chain_fails(self):  # a chain nothing jumps to filters nothing
        self.assertEqual(self.check(mut("\t\tjump DOCKER-USER\n", "")).returncode, 1)

    def test_docker_user_missing_fails(self):
        t = GOOD[:GOOD.index("\tchain forward")] + "}\n"
        self.assertEqual(self.check(t).returncode, 1)

    def test_wrong_public_iface_fails(self):
        self.assertEqual(self.check(GOOD, iface="ens3").returncode, 1)

    def test_nginx_ip_override(self):
        t = GOOD.replace("172.30.10.10", "172.30.10.11")
        self.assertEqual(self.check(t).returncode, 1, "default nginx ip is 172.30.10.10")
        self.assertEqual(self.check(t, "--nginx-ip", "172.30.10.11").returncode, 0)

    def test_empty_or_garbage_ruleset_is_exit_2_not_green(self):
        for t in ("", "   \n", "not a ruleset"):
            r = self.check(t)
            self.assertIn(r.returncode, (1, 2), "empty/garbage input must not pass: %r" % t)
            self.assertNotEqual(r.returncode, 0)

    def test_missing_public_iface_is_usage_error(self):
        r = py(NFT, "--file", "-", stdin=GOOD)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_missing_file_is_usage_error(self):
        r = py(NFT, "--public-iface", "eth0", "--file", str(ROOT / "nope.nft"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_extra_docker_user_chain_in_second_table_does_not_hide_a_violation(self):
        # Docker's own iptables-nft table also has a DOCKER-USER chain (just `return`); a bad one must still be caught
        bad = mut('\t\tiifname "eth0" counter packets 7 bytes 420 drop\n', "")
        other = 'table ip filter {\n\tchain FORWARD {\n\t\ttype filter hook forward priority filter; policy drop;\n' \
                '\t\tjump DOCKER-USER\n\t}\n\tchain DOCKER-USER {\n\t\tcounter packets 0 bytes 0 return\n\t}\n}\n'
        self.assertEqual(self.check(bad + other).returncode, 1)


# ================================================================ other missing suite files
class InternalSuiteComplete(unittest.TestCase):
    TRD_INTERNAL = ["published_ports.py", "secrets_not_default.py", "renderer_egress.sh", "sandbox_envelope.sh",
                    "valkey_ephemeral.sh", "container_hardening.py", "egress_probe.sh", "oncall_sudo.sh", "auth_net.sh",
                    "roles.sql", "auditstore_roles.sql"]
    TRD_EXTERNAL = ["ports.py", "tls.sh", "headers.py", "routes.py", "ratelimit.py"]

    def test_02trd_tree_complete(self):
        miss = ["tests/internal/" + f for f in self.TRD_INTERNAL if not (INT / f).is_file()]
        miss += ["tests/external/" + f for f in self.TRD_EXTERNAL if not (EXT / f).is_file()]
        self.assertEqual(miss, [], "02-TRD s2 test tree incomplete: %s" % miss)

    def test_shell_scripts_parse_and_are_lf(self):
        scripts = sorted(list(INT.glob("*.sh")) + list(EXT.glob("*.sh")))
        self.assertTrue(scripts)
        for s in scripts:
            with self.subTest(script=s.name):
                raw = s.read_bytes()
                if s.name != "probe_lib.sh":  # sourced library, never executed
                    self.assertTrue(raw.startswith(b"#!"), "no shebang")
                self.assertNotIn(b"\r\n", raw, "CRLF breaks bash on the VM")
                r = run([BASH, "-n", s.as_posix()])
                self.assertEqual(r.returncode, 0, r.stderr)

    def test_auth_net_sh_contract(self):  # AC-26.2: GoTrue only on auth_net + db_net, nothing published, unreachable from edge/render
        t = read(INT / "auth_net.sh")
        for w in ("docker inspect", "auth_net", "db_net", "edge_net", "render_net", "probe_lib.sh"):
            self.assertIn(w, t, "auth_net.sh must reference %s" % w)
        self.assertRegex(t, r"(?m)^set -u", "sibling scripts use `set -u`")
        self.assertRegex(t, r"(?i)ports?", "must assert no published port")
        self.assertRegex(t, r"exit 2", "usage error = exit 2 like its siblings")

    def test_oncall_sudo_sh_contract(self):  # 07-SEC: ops_oncall cannot run non-allowlisted sudo / decrypt prod secrets
        t = read(INT / "oncall_sudo.sh")
        self.assertIn("ops_oncall", t)
        self.assertRegex(t, r"sudo\s+-[a-zA-Z]*l", "reads the allowlist with `sudo -l`")
        self.assertRegex(t, r"(?i)decrypt|sops|lims-prod-decrypt", "asserts prod secrets cannot be decrypted")
        self.assertRegex(t, r"(?m)^set -u")

    def test_oncall_sudo_sh_tests_policy_not_outcome(self):  # T-30 review item 1: ask sudo's policy, never execute the command
        t = read(INT / "oncall_sudo.sh")
        self.assertNotRegex(t, r"sudo\s+-n\s+-u\s+\"?\$U\"?\s+sudo", "executing the command gives false greens/side effects")
        self.assertRegex(t, r"sudo\s+-l\s+-U\s+\"\$U\"\s+\$c\b", "allowlist loop checks policy with `sudo -l -U \"$U\" $c`")
        self.assertRegex(t, r"sudo\s+-l\s+-U\s+\"\$U\"\s+/usr/bin/systemctl\s+start\s+lims-prod-decrypt@",
                         "prod decrypt unit checked with `sudo -l -U \"$U\" ...`")

    def test_roles_sql_contract(self):  # 07-SEC: no BYPASSRLS/SUPERUSER for lims_%; REPLICATION only for the two roles (02-TRD s8.1)
        t = read(INT / "roles.sql")
        self.assertRegex(t, r"(?i)rolbypassrls")
        self.assertRegex(t, r"(?i)rolsuper")
        self.assertRegex(t, r"(?i)rolreplication")
        self.assertRegex(t, r"lims\\?_%", "scope: roles named lims_%")
        for role in ("lims_replicator", "lims_audit_ship"):
            self.assertIn(role, t, "REPLICATION allow-list must name %s" % role)
        self.assertRegex(t, r"(?i)RAISE EXCEPTION", "failure = non-zero exit, like auditstore_roles.sql")
        self.assertNotRegex(t, r"(?i)\b(DROP|ALTER|CREATE|INSERT|UPDATE|DELETE|GRANT|REVOKE)\s+(ROLE|USER|TABLE|SCHEMA|INTO)\b",
                            "read-only assertions only")
        self.assertNotIn("\r\n", t)


# ================================================================ run.sh
class RunSh(unittest.TestCase):
    def need_all_mode(self):  # fail fast: today's run.sh ignores its arguments and would run the whole slow gate
        if "LIMS_ENV" not in read(RUN_SH):
            self.fail("run.sh has no `all` mode / LIMS_ENV check yet (running it would execute the full gate)")

    def test_all_needs_lims_env(self):
        self.need_all_mode()
        env = {k: v for k, v in os.environ.items() if k != "LIMS_ENV"}
        r = subprocess.run([BASH, RUN_SH.as_posix(), "all"], cwd=str(ROOT), capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("LIMS_ENV", r.stdout + r.stderr)
        self.assertNotRegex(r.stdout, r"(?m)^(not )?ok - ", "no step may run before the argument check")

    def test_all_rejects_other_envs(self):
        self.need_all_mode()
        for bad in ("dev", "production", "", "prod;id"):
            with self.subTest(env=bad):
                r = run([BASH, RUN_SH.as_posix(), "all"], env={"LIMS_ENV": bad}, timeout=60)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertNotRegex(r.stdout, r"(?m)^(not )?ok - ")

    def test_unknown_mode_is_exit_2(self):
        self.need_all_mode()
        r = run([BASH, RUN_SH.as_posix(), "bogus-mode"], env={"LIMS_ENV": "staging"}, timeout=60)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_all_covers_every_external_and_internal_script(self):
        t = read(RUN_SH)
        self.assertRegex(t, r"(?m)\ball\b", "run.sh needs an `all` mode")
        for d, files in (("external", InternalSuiteComplete.TRD_EXTERNAL), ("internal", InternalSuiteComplete.TRD_INTERNAL)):
            glob_used = re.search(r"tests/%s/\*" % d, t) is not None
            for f in files:
                with self.subTest(file=f):
                    ok = glob_used or f in t or (f == "oncall_sudo.sh" and re.search(r"#\s*quarterly", t))
                    self.assertTrue(ok, "run.sh all does not run %s/%s (name it or glob tests/%s/*)" % (d, f, d))

    def test_all_runs_the_full_static_suite_not_just_t01(self):
        t = read(RUN_SH)
        self.assertRegex(t, r'-s infra/tests/static -p "test_t\*', "`all` must discover every test_t*.py, not only T-01")

    def test_default_gate_unchanged(self):  # test_t01 runs `run.sh` with no argument; it must stay the 4-step gate
        t = read(RUN_SH)
        for w in ("gitleaks", "yamllint", "ansible-lint", "-k Skeleton"):
            self.assertIn(w, t)


# ================================================================ monthly scan timer
def unit(ext):
    hits = [p for p in INFRA.rglob("lims-external-scan." + ext + "*") if "tests" not in p.relative_to(INFRA).parts[:1]
            and "__pycache__" not in p.parts]
    return hits


class ScanTimer(unittest.TestCase):
    def one(self, ext):
        hits = unit(ext)
        self.assertEqual(len(hits), 1, "need exactly one lims-external-scan.%s under infra/ (outside tests/): %s" % (ext, hits))
        return read(hits[0])

    def test_service_runs_the_external_port_scan(self):
        t = self.one("service")
        self.assertRegex(t, r"(?im)^\s*Type\s*=\s*oneshot")
        self.assertRegex(t, r"(?im)^\s*ExecStart\s*=.*tests/external/ports\.py")
        self.assertRegex(t, r"(?im)^\s*ExecStart\s*=.*--inventory\b", "targets come from the active inventory profile (LD-45)")
        self.assertEqual(HOSTNAMES.findall(t), [], "no literal host names (LD-45)")

    def test_service_timeout_bounded(self):
        t = self.one("service")
        m = re.search(r"(?im)^\s*TimeoutStartSec\s*=\s*(\d+)\s*(h|min|m|s)?\s*$", t)
        self.assertIsNotNone(m, "TimeoutStartSec required (a hung scan must not sit forever)")
        secs = int(m.group(1)) * {"h": 3600, "min": 60, "m": 60, "s": 1, None: 1}[m.group(2)]
        self.assertLessEqual(secs, 6 * 3600)
        self.assertGreater(secs, 0)

    def test_result_is_recorded_in_ops_audit(self):  # 02-TRD s18: "monthly, recorded"
        t = self.one("service")
        self.assertRegex(t, r"ci/ops-note\.sh", "scan outcome goes to ops_audit via ops-note.sh")

    def test_timer_is_monthly_and_persistent(self):
        t = self.one("timer")
        cal = re.findall(r"(?im)^\s*OnCalendar\s*=\s*(.+?)\s*$", t)
        self.assertTrue(cal, "no OnCalendar")
        self.assertTrue(all(re.match(r"(?i)^(monthly|\*-\*-\d{1,2}\b.*)$", c) for c in cal),
                        "once a month (monthly or *-*-DD ...): %s" % cal)
        self.assertRegex(t, r"(?im)^\s*Persistent\s*=\s*true")
        self.assertRegex(t, r"(?im)^\s*WantedBy\s*=\s*timers\.target")
        self.assertEqual(HOSTNAMES.findall(t), [])

    def test_installed_and_enabled_on_ops_group(self):
        files = [p for p in (INFRA / "ansible").rglob("*.y*ml") if "lims-external-scan.timer" in p.read_text(encoding="utf-8")]
        self.assertTrue(files, "no Ansible file installs/enables lims-external-scan.timer")
        f = files[0]
        t = f.read_text(encoding="utf-8")
        self.assertRegex(t, r"(?s)lims-external-scan\.timer.{0,400}enabled:\s*(true|yes)|enabled:\s*(true|yes).{0,400}lims-external-scan\.timer",
                         "systemd task must enable the timer")
        site = read(INFRA / "ansible" / "playbooks" / "site.yml")
        rel = f.relative_to(INFRA / "ansible").parts
        if rel[0] == "roles":
            self.assertRegex(site, r"(?m)^\s*-\s*%s\s*$" % re.escape(rel[1]), "role %s is not in site.yml" % rel[1])
            hosts = site
            m = re.search(r"(?ms)^- name:[^\n]*\n\s*hosts:\s*(\S+)\n(?:(?!^- name:).)*?^\s*-\s*%s\s*$" % re.escape(rel[1]), site)
            self.assertIsNotNone(m, "cannot find the play running role %s" % rel[1])
            self.assertIn("ops", m.group(1).split(":"), "role must run on group ops, got hosts: %s" % m.group(1))
        else:
            self.assertRegex(t, r"(?m)^\s*hosts:\s*(\S*:)?ops(:\S*)?\s*$", "the play must target group ops")
            if f.name != "site.yml":
                self.assertRegex(site, r"import_playbook:\s*\S*%s" % re.escape(f.name), "%s is not part of site.yml" % f.name)


if __name__ == "__main__":
    unittest.main()
