"""T-03 tests (tester role): host baseline roles.

Roles: base_os hardening chrony wireguard nftables luks_volumes docker_engine (+ tests/internal/container_hardening.py).
Covers 02-TRD s3.2 (networks), s3.3 (port map), s5.1-5.7, AC-01.4, AC-29.1-29.3, REQ-SEC-125/130/132/137.
Static checks on role files (no VM here); runtime facts (converge twice = 0 changes, unlock unit, nft list ruleset)
are proxied by structure + `ansible-playbook --syntax-check` (CI only, LD-17) and are NOT proven by this file.
Stdlib + PyYAML. Missing role/file = FAIL (never skip), except ansible-playbook off CI (LD-17).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t03_*.py" -v
"""
import ast
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
ANS = INFRA / "ansible"
ROLES = ANS / "roles"
CH = INFRA / "tests" / "internal" / "container_hardening.py"
ROLE_NAMES = ("base_os", "hardening", "chrony", "wireguard", "nftables", "luks_volumes", "docker_engine")
NETS = {  # 02-TRD s3.2: name -> (inventory key, subnet, internal)
    "edge_net": ("edge", "172.30.10.0/24", False),
    "app_net": ("app", "172.30.20.0/24", True),
    "auth_net": ("auth", "172.30.30.0/24", True),
    "render_net": ("render", "172.30.40.0/24", True),
    "db_net": ("db", "172.30.50.0/24", False),
    "egress_net": ("egress", "172.30.60.0/24", False),
}


def files(role):
    d = ROLES / role
    return sorted(p for p in d.rglob("*") if p.is_file()) if d.is_dir() else []


def text(*roles, glob="*"):
    out = []
    for r in roles:
        for p in files(r):
            if p.match(glob):
                try:
                    out.append(p.read_text(encoding="utf-8"))
                except UnicodeDecodeError:
                    pass
    return "\n".join(out)


def find(role, pattern):
    """Files in role whose name matches glob pattern (templates may carry .j2)."""
    return [p for p in files(role) if p.match(pattern)]


def only(role, pattern):
    f = find(role, pattern)
    assert f, f"role {role}: no file matching {pattern}"
    return f[0].read_text(encoding="utf-8")


def yaml_docs(role):
    for p in files(role):
        if p.suffix in (".yml", ".yaml"):
            try:
                yield p, yaml.safe_load(p.read_text(encoding="utf-8"))
            except yaml.YAMLError as e:
                raise AssertionError(f"{p}: invalid YAML: {e}")


def walk(o):
    yield o
    if isinstance(o, dict):
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def strip_jinja(s, repl="X"):
    s = re.sub(r"\{%.*?%\}", "", s, flags=re.S)
    return re.sub(r"\{\{.*?\}\}", repl, s, flags=re.S)


def kv_lines(s, sep=r"\s*=\s*"):
    d = {}
    for ln in strip_jinja(s).splitlines():
        ln = ln.split("#", 1)[0].strip()
        m = re.match(r"^(\S+)" + sep + r"(.*)$", ln)
        if m:
            d[m.group(1)] = m.group(2).strip()
    return d


class Roles(unittest.TestCase):
    def test_all_seven_roles_exist_with_parsable_tasks(self):
        for r in ROLE_NAMES:
            with self.subTest(role=r):
                self.assertTrue((ROLES / r / "tasks" / "main.yml").is_file(), f"roles/{r}/tasks/main.yml missing")
                docs = list(yaml_docs(r))
                self.assertTrue(docs)

    def test_site_yml_uses_every_role_and_orders_them(self):
        site = ANS / "playbooks" / "site.yml"
        self.assertTrue(site.is_file(), "playbooks/site.yml missing")
        s = site.read_text(encoding="utf-8")
        yaml.safe_load(s)
        pos = {}
        for r in ROLE_NAMES:
            m = re.search(r"\b" + r + r"\b", s)
            self.assertTrue(m, f"site.yml does not apply role {r}")
            pos[r] = m.start()
        # base before hardening; wireguard before nftables-dependent docker; luks needs wg (key fetch over wg)
        self.assertLess(pos["base_os"], pos["hardening"])
        self.assertLess(pos["wireguard"], pos["docker_engine"], "docker.service is After=wg-quick@wg0 (TRD 3.3)")
        self.assertLess(pos["wireguard"], pos["luks_volumes"], "unlock fetches the key over wg0 (TRD 5.3)")

    def test_site_yml_syntax_check_on_ci(self):  # LD-17: ansible does not run on native Windows; required when CI=true
        a = shutil.which("ansible-playbook")
        if a is None:
            if os.environ.get("CI") == "true":
                self.fail("ansible-playbook missing on CI")
            self.skipTest("SKIP ansible-playbook (CI only)")
        r = subprocess.run([a, "-i", str(ANS / "inventories" / "dev"), str(ANS / "playbooks" / "site.yml"),
                            "--syntax-check"], cwd=ANS, capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout[-1500:] + r.stderr[-1500:])


class Idempotence(unittest.TestCase):
    """done_when: site.yml converges twice with zero changes. Static proxy: raw command/shell tasks must declare it."""

    def test_command_shell_tasks_declare_changed_when_or_creates(self):
        bad = []
        for r in ROLE_NAMES:
            for p, doc in yaml_docs(r):
                for t in walk(doc):
                    if not isinstance(t, dict):
                        continue
                    for mod in ("command", "shell", "ansible.builtin.command", "ansible.builtin.shell", "raw"):
                        if mod in t:
                            args = t[mod] if isinstance(t[mod], dict) else {}
                            ok = ("changed_when" in t or "creates" in args or "removes" in args
                                  or (isinstance(t[mod], dict) and ("creates" in t[mod] or "removes" in t[mod])))
                            if not ok:
                                bad.append(f"{p.relative_to(ROOT)}: {t.get('name', mod)}")
        self.assertFalse(bad, "command/shell tasks without changed_when/creates/removes:\n" + "\n".join(bad))


class Ssh(unittest.TestCase):  # AC-29.3, TRD 5.2, REQ-SEC-132
    def conf(self):
        return only("hardening", "lims.conf*") if find("hardening", "lims.conf*") else only("base_os", "lims.conf*")

    def test_lims_conf_directives(self):
        c = re.split(r"(?m)^Match\b", self.conf())[0]  # global part only; a trailing Match block (T-29) has its own keys
        d = kv_lines(c, r"\s+")
        # T-29 review item 1: the DR interim SFTP account (group lims-interim-repo, chrooted by a Match block) must pass
        # AllowGroups; humans stay `ops`. Any other group still fails this test.
        self.assertIn(d.get("AllowGroups"), ("ops", "ops lims-interim-repo"), "AllowGroups must be ops [+ lims-interim-repo]")
        want = {"PasswordAuthentication": "no", "KbdInteractiveAuthentication": "no", "PermitRootLogin": "no",
                "MaxAuthTries": "3", "LoginGraceTime": "20", "X11Forwarding": "no",
                "AllowTcpForwarding": "local", "ClientAliveInterval": "300"}
        for k, v in want.items():
            self.assertEqual(d.get(k), v, f"{k} must be {v!r}")

    def test_listens_only_on_wg_address(self):
        c = self.conf()
        addrs = re.findall(r"^\s*ListenAddress\s+(.+)$", c, re.M)
        self.assertEqual(len(addrs), 1, "exactly one ListenAddress")
        self.assertRegex(addrs[0], r"\{\{\s*wg_ip\s*\}\}", "ListenAddress must be the wg IP variable")
        self.assertNotRegex(c, r"ListenAddress\s+(0\.0\.0\.0|::)\b")
        self.assertNotRegex(c, r"(?m)^\s*PasswordAuthentication\s+yes")

    def test_sshd_config_validated_before_apply(self):  # lockout guard: a bad file over a wg-only sshd = lost host
        t = text("hardening", "base_os")
        self.assertRegex(t, r"sshd\s+-t", "sshd config must be validated (validate: 'sshd -t -f %s')")

    def test_sshd_waits_for_wg0(self):  # ListenAddress on a not-yet-existing IP makes sshd fail to start
        t = text("hardening", "base_os", "wireguard")
        self.assertRegex(t, r"After=.*wg-quick@wg0\.service|ip_nonlocal_bind\s*=\s*1",
                         "sshd must be ordered After=wg-quick@wg0.service (drop-in) or ip_nonlocal_bind=1")

    def test_ssh_not_open_to_public_in_nft(self):
        for ln in text("nftables").splitlines():
            if re.search(r"dport\s*\{?[^#]*\b22\b", ln) and "accept" in ln:
                self.assertRegex(ln, r"wg0|saddr", f"port 22 accepted without wg0/saddr scope: {ln.strip()}")


class UsersAndPackages(unittest.TestCase):  # TRD 5.1
    def test_removed_services(self):
        t = text("base_os", "hardening")
        for p in ("snapd", "cups", "avahi", "rpcbind", "telnet"):
            self.assertIn(p, t, f"{p} must be removed/disabled")

    def test_ops_users_group_and_sudo_with_password(self):
        t = text("base_os", "hardening")
        self.assertRegex(t, r"ops_", "named accounts ops_<name>")
        self.assertRegex(t, r"\bops\b", "group ops (sshd AllowGroups)")
        self.assertNotIn("NOPASSWD", t, "sudo with password + key (TRD 5.1)")
        if "sudoers" in t:
            self.assertIn("visudo", t, "sudoers files must be validated with visudo -cf")

    def test_no_shared_or_default_accounts_or_passwords(self):
        t = text("base_os", "hardening")
        self.assertNotRegex(t, r"(?i)password:\s*['\"]?(?!\{\{|!|\*)\S{3,}", "no literal password hash/plain in roles")
        self.assertNotRegex(t, r"(?i)\bchpasswd\b")

    def test_unattended_security_downloads_but_no_auto_install(self):
        t = text("base_os", "hardening")
        self.assertRegex(t, r'Unattended-Upgrade\s+"0"', "automatic install off (patches via s13)")
        self.assertRegex(t, r'Download-Upgradeable-Packages\s+"1"')


class Sysctl(unittest.TestCase):  # TRD 5.4
    WANT = {
        "net.ipv4.tcp_syncookies": "1", "net.ipv4.tcp_max_syn_backlog": "8192", "net.core.somaxconn": "4096",
        "net.ipv4.tcp_fin_timeout": "15", "net.ipv4.conf.all.rp_filter": "1",
        "net.ipv4.conf.all.accept_redirects": "0", "net.ipv4.conf.all.send_redirects": "0",
        "net.ipv4.icmp_echo_ignore_broadcasts": "1", "net.ipv6.conf.all.accept_ra": "0",
        "fs.file-max": "1048576", "kernel.kptr_restrict": "2", "kernel.dmesg_restrict": "1",
    }

    def test_90_lims_conf_values(self):
        c = only("hardening", "90-lims.conf*") if find("hardening", "90-lims.conf*") else only("base_os", "90-lims.conf*")
        d = kv_lines(c)
        for k, v in self.WANT.items():
            self.assertEqual(d.get(k), v, f"{k} = {v}")
        self.assertIn("vm.swappiness", d)

    def test_swappiness_10_default_1_on_data(self):
        t = text("hardening", "base_os")
        self.assertRegex(t, r"swappiness")
        self.assertRegex(t, r"swappiness[^\n]*\b10\b|\b10\b[^\n]*swappiness", "default 10")
        self.assertRegex(t, r"(?s)swappiness.{0,200}(groups\[?['\"\.]?data|data)|(data).{0,200}swappiness",
                         "data-1 override to 1")


class Chrony(unittest.TestCase):  # AC-29.2, TRD 5.6, REQ-SEC-137
    def conf(self):
        return only("chrony", "chrony.conf*")

    def test_ops_is_server_on_upstreams_others_use_ops_and_provider(self):
        c = self.conf()
        self.assertIn("ntp_upstreams", c, "ops-1 syncs to ntp_upstreams from inventory")
        self.assertRegex(c, r"(?m)^\s*(server|pool)\b")
        self.assertRegex(c, r"groups\[['\"]ops['\"]\]|groups\.ops|ops_wg_ip|hostvars", "clients sync to ops-1 over wg")
        self.assertRegex(c, r"iburst")

    def test_server_allow_limited_to_wg_subnet(self):
        c = self.conf()
        allows = re.findall(r"(?m)^\s*allow\b(.*)$", c)
        self.assertTrue(allows, "ops-1 must `allow` its clients")
        for a in allows:
            self.assertRegex(a, r"wg_subnet|10\.(77|78|79)\.0\.0/24", f"allow must be wg-only: {a}")
            self.assertNotRegex(a, r"^\s*all\b|0\.0\.0\.0/0")

    def test_clock_skew_metric_and_sync_check(self):
        t = text("chrony")
        self.assertIn("node_timex_offset_seconds", t, "role must assert/verify the ClockSkew source metric (TRD 5.6)")
        self.assertRegex(t, r"chronyc\s+tracking|chronyc\s+-c\s+tracking", "sync check")

    def test_chronyd_enabled(self):
        t = text("chrony")
        self.assertRegex(t, r"chrony(d)?\b[^\n]*(\n[^\n]*){0,4}enabled:\s*(true|yes)|enabled:\s*(true|yes)(\n[^\n]*){0,4}chrony")


class WireGuard(unittest.TestCase):  # TRD 3.2/3.3, 12.1
    def conf(self):
        return only("wireguard", "wg0.conf*")

    def test_interface_and_peers(self):
        c = self.conf()
        self.assertIn("[Interface]", c)
        self.assertRegex(c, r"ListenPort\s*=\s*51820")
        self.assertRegex(c, r"Address\s*=\s*.*wg_ip")
        self.assertIn("[Peer]", c)
        self.assertRegex(c, r"AllowedIPs\s*=\s*.*\{\{", "peer AllowedIPs come from inventory wg_ip")
        self.assertNotRegex(c, r"AllowedIPs\s*=\s*0\.0\.0\.0/0", "no full tunnel / default route")

    def test_private_key_not_inline_not_world_readable(self):
        t = text("wireguard")
        self.assertNotRegex(t, r"(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])",
                            "no literal WireGuard key in the role")
        c = self.conf()
        self.assertRegex(c, r"PrivateKey\s*=\s*\{\{|PostUp\s*=.*private|PrivateKey.*file", "key from secret render/file")
        self.assertRegex(t, r"mode:\s*['\"]?0?600", "wg0.conf / key mode 0600")

    def test_wg_quick_service_enabled(self):
        self.assertRegex(text("wireguard"), r"wg-quick@wg0")

    def test_ip_forward_not_needed_on_hub_only_via_explicit_var(self):
        # a hub that forwards between peers must be deliberate (ops-1 hub); never a blanket 'accept all' forward
        self.assertNotRegex(text("wireguard", "nftables"), r"policy accept;\s*\n[^\n]*hook forward|hook forward[^\n]*policy accept")


class Nftables(unittest.TestCase):  # AC-01.4, TRD 5.5
    def rs(self):
        return text("nftables")

    def test_input_policy_drop(self):  # AC-01.4
        r = self.rs()
        self.assertRegex(r, r"table inet filter")
        self.assertRegex(r, r"hook input[^}]*?policy drop", "input policy drop")
        self.assertNotRegex(r, r"hook input[^}\n]*policy accept")

    def test_input_allows(self):
        r = self.rs()
        self.assertRegex(r, r"ct state (established,\s*related|related,\s*established)\s+accept")
        self.assertRegex(r, r'(iif|iifname)\s+"?lo"?\s+accept')
        self.assertRegex(r, r"icmp type echo-request[^\n]*limit rate\s+10/second|limit rate\s+10/second[^\n]*echo-request")
        self.assertRegex(r, r"udp dport 51820[^\n]*ip saddr @wg_peers", "wg only from peers")
        self.assertRegex(r, r"set wg_peers")
        self.assertRegex(r, r"tcp dport\s*\{\s*80,\s*443\s*\}", "80/443 on app-1")

    def test_wg0_port_map_scoped_by_source(self):  # TRD 3.3: db only from app-1/dr-1 wg IPs; ops-1 never
        lines = [l for l in self.rs().splitlines() if "accept" in l and not l.strip().startswith("#")]
        for port in ("5432", "6432", "9100", "2020"):
            hit = [l for l in lines if re.search(r"dport[^\n]*\b" + port + r"\b", l)]
            self.assertTrue(hit, f"no rule for port {port}")
            for l in hit:
                self.assertRegex(l, r"saddr|iifname \"?wg0|iif \"?wg0", f"port {port} rule not scoped: {l.strip()}")
        self.assertRegex(self.rs(), r"udp dport 123", "ops-1 chrony server")

    def test_ruleset_validated_before_load(self):  # lockout guard
        self.assertRegex(text("nftables"), r"nft\s+(-c|--check)\b", "validate with `nft -c -f` before loading")

    def test_docker_user_chain_rules_in_order(self):  # AC-01.4, TRD 5.5 (08 A25 D-203)
        r = self.rs()
        i = r.find("DOCKER-USER")
        self.assertGreaterEqual(i, 0, "DOCKER-USER chain missing")
        b = r[i:]

        def at(rx, start=0):
            m = re.search(rx, b[start:], re.I | re.S)
            self.assertTrue(m, f"DOCKER-USER: missing {rx}")
            return start + m.start()

        sub = lambda k: rf"(172\.30\.{k}\.0/24|\{{\{{\s*docker_subnets(\.|\[['\"]){NET_KEY[k]})"
        p1 = at(r"established")
        p2 = at(r"172\.30\.10\.10|nginx_edge_ip", p1)                       # public iface -> nginx only
        p3 = at(sub(10), p2 + 1)                                              # edge_net: nginx only
        p4 = at(r"db_primary_wg_ip", p3)                                      # db_net allowlist
        p5 = at(r"smtp_relay_ips", p4)                                        # GoTrue SMTP exception
        p6 = at(sub(40), p5)                                                  # render_net drop
        p7 = at(r"egress_net|" + sub(60), p6)                                 # egress_net squid only
        self.assertTrue(p1 < p2 < p3 < p4 < p5 < p6 < p7)
        self.assertRegex(b, r"5432[,\s}]*6432|6432[,\s}]*5432|\{\s*5432,\s*6432\s*\}")
        self.assertRegex(b, r"172\.30\.50\.20|auth_ip", "GoTrue fixed IP")
        self.assertRegex(b, r"\b587\b")
        self.assertRegex(b, r"\bdrop\b")
        self.assertRegex(b, r"public_iface|public_if|iifname")

    def test_docker_user_defence_in_depth_internal_nets(self):
        b = self.rs()
        for k in ("20", "30"):
            self.assertRegex(b, rf"172\.30\.{k}\.0/24|docker_subnets\.(app|auth)|docker_subnets\[['\"](app|auth)",
                             f"app_net/auth_net (172.30.{k}.0/24) drop rule")


NET_KEY = {10: "edge", 20: "app", 30: "auth", 40: "render", 50: "db", 60: "egress"}


class LuksVolumes(unittest.TestCase):  # AC-29.1, TRD 5.3, REQ-SEC-125
    def test_luks2_on_every_vg(self):
        t = text("luks_volumes")
        self.assertRegex(t, r"luks2", "LUKS2")
        for vg in ("vg_db", "vg_repo", "vg_storage", "vg_dr", "vg_ops"):
            self.assertIn(vg, t)
        self.assertRegex(t, r"cryptsetup\s+(.*\s)?luksFormat|community\.crypto\.luks_device", "format step")

    def test_format_is_guarded_never_reformats(self):  # data-loss guard + idempotence
        t = text("luks_volumes")
        self.assertRegex(t, r"isLuks|luks_device|state:\s*opened|blkid", "luksFormat must be guarded (isLuks/blkid)")

    def test_filesystems(self):
        t = text("luks_volumes")
        self.assertRegex(t, r"xfs")
        self.assertRegex(t, r"ext4")
        self.assertRegex(t, r"(?s)vg_storage.{0,400}xfs|xfs.{0,400}vg_storage", "XFS on vg_storage (growable)")

    def test_devices_come_from_inventory_disks_not_hardcoded(self):
        t = text("luks_volumes")
        self.assertRegex(t, r"disks\b|disks\.")
        self.assertNotRegex(t, r"/dev/(sd[a-z]|vd[a-z]|xvd|nvme\d)", "no hardcoded device names (by-id from hosts.yml)")

    def test_unlock_unit(self):
        u = only("luks_volumes", "lims-luks-unlock.service*")
        self.assertRegex(u, r"\[Unit\]")
        self.assertRegex(u, r"After=.*(wg-quick@wg0\.service|network-online\.target)")
        self.assertRegex(u, r"ExecStart=")
        t = text("luks_volumes")
        self.assertRegex(t, r"ops-1|groups\[['\"]ops['\"]\]|ops_wg_ip", "key fetched from ops-1")
        self.assertRegex(t, r"\bage\b", "per-volume key encrypted to the host age key")

    def test_unlock_falls_back_to_console_passphrase(self):  # done_when
        t = text("luks_volumes")
        self.assertRegex(t, r"systemd-ask-password|--key-file\s+-|ask-password|cryptsetup\s+open\b(?!.*--key-file)|console",
                         "fallback to console passphrase when ops-1 unreachable")
        self.assertRegex(t, r"(?i)(\|\||else|fallback|on failure|rescue|OnFailure)", "explicit fallback path")

    def test_keys_never_on_plaintext_disk(self):  # AC-29.1 / REQ-SEC-125
        t = text("luks_volumes")
        self.assertRegex(t, r"/run/|tmpfs|/dev/shm", "fetched keyfile lives in tmpfs")
        self.assertRegex(t, r"shred|rm\s+-[a-z]*f|state:\s*absent|ExecStartPost=.*rm", "keyfile removed after unlock")
        self.assertNotRegex(t, r"(--key-file|keyfile|key_file)\s*[=:]?\s*['\"]?/(etc|root|var|home|boot)/",
                            "no keyfile under /etc,/root,/var,/home,/boot")
        self.assertNotRegex(t, r"(?m)^\s*luks_passphrase\s*:\s*\S", "no literal passphrase")
        self.assertNotRegex(t, r"crypttab[^\n]*\bnone\b[^\n]*luks[^\n]*\n[^\n]*keyscript|/etc/luks-keys")

    def test_ops_1_unlocked_by_passphrase_only(self):  # TRD 5.3
        t = text("luks_volumes")
        self.assertRegex(t, r"ops", "ops-1 volumes handled separately (manual passphrase)")

    def test_shell_scripts_syntax(self):
        bash = shutil.which("bash") or r"C:\Program Files\Git\bin\bash.exe"
        scripts = [p for r in ("luks_volumes", "docker_engine", "base_os", "hardening", "chrony", "wireguard", "nftables")
                   for p in files(r) if p.suffix == ".sh" and "{{" not in p.read_text(encoding="utf-8")
                   and "{%" not in p.read_text(encoding="utf-8")]
        if not scripts:
            return
        if not Path(bash).exists() and not shutil.which("bash"):
            self.fail("bash missing")
        for s in scripts:
            r = subprocess.run([bash, "-n", str(s)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, f"{s}: {r.stderr}")


class DockerEngine(unittest.TestCase):  # TRD 3.2, 5.7, REQ-SEC-130
    def daemon_text(self):
        return only("docker_engine", "daemon.json*")

    def daemon(self):
        return json.loads(strip_jinja(self.daemon_text(), "65536"))

    def test_daemon_json_exact(self):
        d = self.daemon()
        self.assertEqual(d["log-driver"], "json-file")
        self.assertEqual(d["log-opts"], {"max-size": "50m", "max-file": "5"})
        self.assertIs(d["live-restore"], True)
        self.assertIs(d["no-new-privileges"], True)
        self.assertIs(d["icc"], False)
        self.assertIs(d["userland-proxy"], False)
        self.assertEqual(d["default-ulimits"], {"nofile": {"Name": "nofile", "Soft": 65536, "Hard": 65536}})

    def test_no_docker_sock_mounts_or_tcp_api(self):
        t = text("docker_engine")
        self.assertNotRegex(t, r"2375|2376|tcp://0\.0\.0\.0")
        self.assertNotRegex(t, r"-v\s+/var/run/docker\.sock|/var/run/docker\.sock:")
        self.assertNotRegex(self.daemon_text(), r'"hosts"\s*:')

    def test_docker_after_wg0(self):
        t = text("docker_engine")
        self.assertRegex(t, r"After=[^\n]*wg-quick@wg0\.service")

    def test_br_netfilter(self):  # TRD 3.2
        t = text("docker_engine")
        self.assertIn("br_netfilter", t)
        self.assertRegex(t, r"net\.bridge\.bridge-nf-call-iptables\s*[=:]\s*['\"]?1")

    def test_six_networks(self):
        found = {}
        for r in ("docker_engine",):
            for p, doc in yaml_docs(r):
                for n in walk(doc):
                    if isinstance(n, dict) and n.get("name") in NETS:
                        found.setdefault(n["name"], n)
        for name, (key, subnet, internal) in NETS.items():
            with self.subTest(net=name):
                self.assertIn(name, found, f"{name} not defined as a mapping with `name:` in docker_engine role")
                blob = yaml.safe_dump(found[name])
                self.assertRegex(blob, re.escape(subnet) + rf"|docker_subnets(\.|\[['\"]){key}",
                                 f"{name} subnet {subnet} (literal or docker_subnets.{key})")
                flag = found[name].get("internal", False)
                self.assertEqual(bool(flag) and str(flag).lower() not in ("false", "no"), internal,
                                 f"{name} internal must be {internal}")

    def test_inventory_subnets_match_trd(self):
        for env in ("dev", "staging", "prod"):
            g = yaml.safe_load((ANS / "inventories" / env / "group_vars" / "all.yml").read_text(encoding="utf-8"))
            for _, (key, subnet, _i) in NETS.items():
                self.assertEqual(g["docker_subnets"][key], subnet, f"{env} docker_subnets.{key}")

    def test_nginx_fixed_ip_on_edge_net(self):
        self.assertRegex(text("docker_engine", "nftables"), r"172\.30\.10\.10|nginx_edge_ip")


class ContainerHardeningScript(unittest.TestCase):  # tests: container_hardening.py (daemon.json)
    """Contract (tester assumption, documented in T-03-tests.md): `python container_hardening.py --daemon-json PATH`
    checks only that file: exit 0 when it satisfies 02-TRD s5.7, non-zero and names the offending key otherwise."""

    GOOD = {"log-driver": "json-file", "log-opts": {"max-size": "50m", "max-file": "5"}, "live-restore": True,
            "no-new-privileges": True, "icc": False, "userland-proxy": False,
            "default-ulimits": {"nofile": {"Name": "nofile", "Soft": 65536, "Hard": 65536}}}

    def run_ch(self, doc):
        self.assertTrue(CH.is_file(), "infra/tests/internal/container_hardening.py missing")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "daemon.json"
            p.write_text(doc if isinstance(doc, str) else json.dumps(doc), encoding="utf-8")
            return subprocess.run([sys.executable, "-B", "-I", str(CH), "--daemon-json", str(p)],
                                  capture_output=True, text=True, timeout=60)

    def test_stdlib_only_and_parses(self):
        self.assertTrue(CH.is_file(), "container_hardening.py missing")
        tree = ast.parse(CH.read_text(encoding="utf-8"))
        std = set(sys.stdlib_module_names)
        for n in ast.walk(tree):
            mods = [a.name for a in n.names] if isinstance(n, ast.Import) else [n.module or ""] if isinstance(n, ast.ImportFrom) else []
            for m in mods:
                self.assertIn(m.split(".")[0], std, f"non-stdlib import {m} (runs on product hosts)")

    def test_good_daemon_json_passes(self):
        r = self.run_ch(self.GOOD)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_each_deviation_fails_and_is_named(self):
        def mut(f):
            d = json.loads(json.dumps(self.GOOD))
            f(d)
            return d
        cases = {
            "icc": mut(lambda d: d.update(icc=True)),
            "userland-proxy": mut(lambda d: d.update({"userland-proxy": True})),
            "live-restore": mut(lambda d: d.pop("live-restore")),
            "no-new-privileges": mut(lambda d: d.update({"no-new-privileges": False})),
            "log-driver": mut(lambda d: d.update({"log-driver": "none"})),
            "max-size": mut(lambda d: d["log-opts"].update({"max-size": "10g"})),
            "max-file": mut(lambda d: d["log-opts"].pop("max-file")),
            "default-ulimits": mut(lambda d: d["default-ulimits"]["nofile"].update(Soft=1024)),
        }
        for key, doc in cases.items():
            with self.subTest(deviation=key):
                r = self.run_ch(doc)
                self.assertNotEqual(r.returncode, 0, f"{key} deviation accepted")
                self.assertIn(key, r.stdout + r.stderr, "failure must name the offending key")

    def test_malformed_or_exposed_api_fails(self):
        self.assertNotEqual(self.run_ch("{not json").returncode, 0)
        self.assertNotEqual(self.run_ch(dict(self.GOOD, hosts=["tcp://0.0.0.0:2375"])).returncode, 0,
                            "TCP API without TLS must fail")

    def test_missing_file_fails_not_passes(self):
        self.assertTrue(CH.is_file(), "container_hardening.py missing")
        r = subprocess.run([sys.executable, "-B", "-I", str(CH), "--daemon-json", str(ROOT / "nope" / "daemon.json")],
                           capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)

    def test_rendered_role_daemon_json_passes_the_checker(self):
        d = json.loads(strip_jinja(only("docker_engine", "daemon.json*"), "65536"))
        r = self.run_ch(d)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
