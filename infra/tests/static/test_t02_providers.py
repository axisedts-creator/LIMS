"""T-02 tests (tester role): provider abstraction + inventories (generic).

Covers IS-01, 02-TRD s3.4 (provider contract), s3.1/s3.2 (host layout per env), s4 (inventory rules),
s12.1 (env separation, wg subnets), REQ-SEC-136, AC-21.1 (distinct envs).
Done when: dev inventory describes ONE generic VM; no provider value outside infra/providers/<name>/
and infra/ansible/inventories/*/hosts.yml (grep check).
Stdlib + PyYAML (a yamllint dependency). Missing tool = FAIL (never skip), except ansible-inventory off CI (LD-17).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t02_*.py" -v
"""
import configparser
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
INV = ANS / "inventories"
PROV = INFRA / "providers"
# LD-45/LD-48: two topology profiles. full = 4-host TRD s3.1 (+ staging 2 VMs); lean = prod-1 + backup-1, staging = 1 VM.
PROFILES = {"full": ("dev", "staging", "prod"), "lean": ("dev", "staging-lean", "prod-lean")}
LEAN_ONLY = ("staging-lean", "prod-lean")
ENVS = ("dev", "staging", "prod", "staging-lean", "prod-lean")  # every inventory dir
BASE_ENV = {"staging-lean": "staging", "prod-lean": "prod"}  # a lean inventory shares its env's wg subnet (T-02-impl [CONV])
GROUPS = ("data", "app", "dr", "ops")
LEAN_GROUPS = GROUPS + ("backup",)  # LD-48: new group `backup`
GVARS = ("all", "data", "app", "dr", "ops")
LEAN_GVARS = GVARS + ("backup",)
SUBNET = {"prod": "10.77.0.", "staging": "10.78.0.", "dev": "10.79.0."}  # 02-TRD s12.1 [CONV]
PROD_HOSTS = {"data-1", "app-1", "dr-1", "ops-1"}  # 02-TRD s3.1
RAM_BUDGET = 0.85  # LD-45: sum(mem_limit) <= 85 % of host RAM


def groups_of(e):
    return LEAN_GROUPS if e in LEAN_ONLY else GROUPS


def gvars_of(e):
    return LEAN_GVARS if e in LEAN_ONLY else GVARS


def subnet_of(e):
    return SUBNET[BASE_ENV.get(e, e)]

# Provider-specific values: vendor names, cloud regions/instance ids, metadata endpoint, cloud disk names.
# Hosting contexts only (T-02 ruling): bare googleapis/azure/aws also appear in non-hosting places
# (Envoy protobuf type URLs, vendored OAuth settings, foreign-registry deny lists).
PROVIDER_RX = re.compile(
    r"amazonaws\.com|\bec2\b|\.azure\.com|compute\.googleapis\.com|cloud\.google\.com|\bgcp\b|"
    r"digitalocean|hetzner|linode|vultr|\bovh|alibaba|aliyun|scaleway|contabo|rackspace|"
    r"\bi-[0-9a-f]{8,17}\b|"
    r"\b(?:us|eu|ap|sa|ca|me|af)-(?:north|south|east|west|central|southeast|northeast)-\d\b|/dev/xvd",
    re.I,
)
METADATA_RX = re.compile(r"169\.254\.169\.254")  # allowed only in tests/ (deny/probe assertions)
VENDORED = "compose/supabase/upstream/"  # verbatim upstream, not LIMS-authored config


def read(p):
    return p.read_text(encoding="utf-8")


def load(p):
    return yaml.safe_load(read(p))


def provider_scan(base):
    """grep check: files under <base> (an infra/ root) holding a provider value, outside the allowed paths."""
    hits = []
    for p in sorted(base.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts:
            continue
        rel = p.relative_to(base).as_posix()
        if rel.startswith(("providers/", VENDORED)) or rel == "tests/static/test_t02_providers.py":
            continue
        if re.fullmatch(r"ansible/inventories/[^/]+/hosts\.yml", rel):
            continue
        try:
            t = read(p)
        except (UnicodeDecodeError, OSError):
            continue
        m = PROVIDER_RX.search(t) or (None if rel.startswith("tests/") else METADATA_RX.search(t))
        if m:
            hits.append(f"{rel}: {m.group(0)!r}")
    return hits


def inventory(path):
    """-> (groups {name: set(hosts)}, hostvars {host: dict}) from a YAML inventory (children nested)."""
    groups, hv = {}, {}

    def walk(name, body):
        body = body or {}
        groups.setdefault(name, set())
        for h, v in (body.get("hosts") or {}).items():
            groups[name].add(h)
            hv.setdefault(h, {}).update(v or {})
        for c, cb in (body.get("children") or {}).items():
            walk(c, cb)
            groups[name] |= groups[c]

    for k, v in (load(path) or {}).items():
        walk(k, v)
    return groups, hv


def mem_problems(hv):
    """LD-45/LD-48: per host carrying host_ram_gib / mem_limit_gib -> list of problems (empty = ok)."""
    bad = []
    for h, v in sorted(hv.items()):
        ram, lim = v.get("host_ram_gib"), v.get("mem_limit_gib")
        if lim is None:
            continue  # RAM alone is fine (backup-1: LD-45 gives no per-service budget); prod-1 is pinned separately
        if ram is None:
            bad.append(f"{h}: mem_limit_gib without host_ram_gib")
            continue
        total = 0.0
        for svc, s in lim.items():
            if not isinstance(s, dict) or "replicas" not in s or "gib" not in s:
                bad.append(f"{h}/{svc}: needs replicas and gib")
                continue
            total += s["replicas"] * s["gib"]
        if total > RAM_BUDGET * ram + 1e-9:
            bad.append(f"{h}: sum mem_limit {total} GiB > {RAM_BUDGET:.0%} of {ram} GiB")
    return bad


class ProviderDocs(unittest.TestCase):  # 02-TRD s3.4
    CONTRACT = [  # (what, regex) - each of the five adapter duties must be written down
        ("Ubuntu 24.04 image", r"ubuntu\s*24\.04"),
        ("static public IPv4", r"static.{0,40}ipv4|ipv4.{0,40}static"),
        ("private disks as block devices / by-id", r"block device|/dev/disk/by-id"),
        ("firewall 80/443 + 51820/udp", r"51820"),
        ("out-of-band console", r"console"),
        ("snapshot capability", r"snapshot"),
        ("DR site separate building/power in Nepal", r"power|building"),
        ("Nepal", r"nepal"),
    ]

    def test_files_exist(self):
        want = [PROV / "README.md", PROV / "generic/checklist.md", PROV / "generic/hosts.example.yml"]
        self.assertEqual([str(w.relative_to(ROOT)) for w in want if not w.is_file()], [])

    def test_readme_states_contract_and_boundary(self):
        t = read(PROV / "README.md").lower()
        for what, rx in self.CONTRACT:
            self.assertRegex(t, rx, f"providers/README.md must state: {what}")
        for needle in ("checklist.md", "generic", "hosts.yml", "providers/<name>"):
            self.assertIn(needle, t, f"providers/README.md must mention `{needle}`")
        self.assertRegex(t, r"no provider.specific value|outside", "README must state the no-provider-value-elsewhere rule")

    def test_generic_checklist_covers_contract(self):
        t = read(PROV / "generic/checklist.md").lower()
        for what, rx in self.CONTRACT:
            self.assertRegex(t, rx, f"generic/checklist.md must cover: {what}")
        self.assertRegex(t, r"80", "ports 80/443")
        self.assertIn("443", t)
        self.assertRegex(t, r"(?m)^\s*(?:(?:[-*]|\d+\.)\s*\[[ xX]\]|\d+\.)", "checklist must be a list of steps")

    def test_hosts_example_is_valid_generic_inventory(self):
        p = PROV / "generic/hosts.example.yml"
        g, hv = inventory(p)
        for grp in GROUPS:
            self.assertIn(grp, g, f"hosts.example.yml: group `{grp}`")
        self.assertTrue(hv, "hosts.example.yml: no hosts")
        for h, v in hv.items():
            self.assertTrue(v.get("ansible_host"), f"{h}: ansible_host (static public IPv4) missing")
        self.assertIn("/dev/disk/by-id/", read(p), "by-id disk names must be recorded (s3.4 item 1)")
        self.assertNotRegex(read(p), r"(?i)password|private key|begin .*key", "no secrets in an example inventory")


class InventoryLayout(unittest.TestCase):  # 02-TRD s1, s3.1, s3.2
    def test_required_files_per_env(self):
        want = []
        for e in ENVS:
            want += [INV / e / "hosts.yml", INV / e / "known_hosts"]
            want += [INV / e / "group_vars" / f"{g}.yml" for g in gvars_of(e)]  # lean: + backup.yml (LD-48)
        self.assertEqual([str(w.relative_to(ROOT)) for w in want if not w.is_file()], [])

    def test_no_inventory_dir_escapes_the_tests(self):
        got = sorted(p.name for p in INV.iterdir() if p.is_dir())
        self.assertEqual(got, sorted(ENVS), "every inventory dir must be covered by these tests (add it to ENVS)")

    def test_all_groups_in_every_hosts_yml(self):  # lean inventories also carry `backup` (LD-48)
        for e in ENVS:
            g, _ = inventory(INV / e / "hosts.yml")
            for grp in groups_of(e):
                self.assertIn(grp, g, f"{e}: group `{grp}`")

    def test_dev_is_one_generic_vm_all_roles_except_dr(self):
        g, hv = inventory(INV / "dev" / "hosts.yml")
        self.assertEqual(len(hv), 1, f"dev = one VM, got {sorted(hv)}")
        (host,) = hv
        for grp in ("data", "app", "ops"):
            self.assertEqual(g[grp], {host}, f"dev: `{grp}` must be on the single VM")
        self.assertEqual(g["dr"], set(), "dev has no dr role")

    def test_staging_is_two_vms_site_split(self):
        g, hv = inventory(INV / "staging" / "hosts.yml")
        self.assertEqual(len(hv), 2, f"staging = 2 VMs, got {sorted(hv)}")
        self.assertEqual(g["data"], g["app"], "staging site A: data+app on one VM")
        self.assertEqual(g["dr"], g["ops"], "staging site B: dr+ops on one VM")
        self.assertEqual(len(g["data"]), 1)
        self.assertEqual(len(g["dr"]), 1)
        self.assertFalse(g["data"] & g["dr"], "site A and site B VMs must differ")

    def test_prod_is_four_named_vms_one_per_group(self):
        g, hv = inventory(INV / "prod" / "hosts.yml")
        self.assertEqual(set(hv), PROD_HOSTS)
        for grp, host in zip(GROUPS, ("data-1", "app-1", "dr-1", "ops-1")):
            self.assertEqual(g[grp], {host}, f"prod: `{grp}`")

    def test_prod_lean_roles_map_to_prod_1_and_backup_1(self):  # LD-45, LD-48
        g, hv = inventory(INV / "prod-lean" / "hosts.yml")
        self.assertEqual(set(hv), {"prod-1", "backup-1"}, "prod-lean = exactly prod-1 + backup-1")
        for grp in ("data", "app", "ops"):
            self.assertEqual(g[grp], {"prod-1"}, f"prod-lean: prod-1 must be the only member of `{grp}`")
        self.assertEqual(g["backup"], {"backup-1"}, "prod-lean: backup-1 is the only member of `backup`")
        for grp, members in g.items():
            if grp not in ("backup", "all"):  # `all` is the implicit parent of every host
                self.assertNotIn("backup-1", members, f"prod-lean: backup-1 must be in `backup` only, found in `{grp}`")
        self.assertEqual(g["dr"], set(), "prod-lean: no hot standby, group `dr` empty (LD-45)")
        self.assertNotEqual(hv["prod-1"]["public_ip"], hv["backup-1"]["public_ip"])

    def test_staging_lean_is_exactly_one_vm(self):  # LD-45, LD-48
        g, hv = inventory(INV / "staging-lean" / "hosts.yml")
        self.assertEqual(len(hv), 1, f"staging-lean = one VM, got {sorted(hv)}")
        (host,) = hv
        for grp in ("data", "app", "ops"):
            self.assertEqual(g[grp], {host}, f"staging-lean: `{grp}` on the single VM")
        self.assertEqual(g["dr"], set())
        self.assertEqual(g["backup"], set())

    def test_every_role_maps_to_a_host_in_each_profile(self):  # LD-48; dev(lean) has no dr/backup
        for prof, envs in PROFILES.items():
            for e in envs:
                g, _ = inventory(INV / e / "hosts.yml")
                need = ["data", "app", "ops"]
                if e == "prod":
                    need.append("dr")  # full prod keeps the standby site
                if e == "prod-lean":
                    need.append("backup")
                for grp in need:
                    self.assertTrue(g.get(grp), f"{prof}/{e}: role group `{grp}` has no host")

    def test_topology_profile_var_selects_profile(self):  # LD-48: group vars select per-profile values
        want = {"prod-lean": "lean", "staging-lean": "lean", "prod": "full"}
        for e, prof in want.items():
            d = load(INV / e / "group_vars" / "all.yml")
            self.assertEqual(d.get("topology_profile"), prof, f"{e}: topology_profile")

    def test_every_host_has_address_and_by_id_disk(self):
        for e in ENVS:
            p = INV / e / "hosts.yml"
            _, hv = inventory(p)
            for h, v in hv.items():
                self.assertTrue(v.get("ansible_host"), f"{e}/{h}: ansible_host")
            self.assertIn("/dev/disk/by-id/", read(p), f"{e}: private disks recorded as /dev/disk/by-id names (s3.4)")

    def test_group_vars_parse_and_hold_no_host_specific_values(self):
        for e in ENVS:
            for gname in gvars_of(e):
                p = INV / e / "group_vars" / f"{gname}.yml"
                d = load(p)
                self.assertTrue(d is None or isinstance(d, dict), f"{p.name}: must be a mapping")
                t = read(p)
                self.assertNotIn("/dev/disk/by-id/", t, f"{e}/{p.name}: disk names belong in hosts.yml only")
                self.assertNotRegex(t, r"(?m)^\s*ansible_host\s*:", f"{e}/{p.name}: addresses belong in hosts.yml only")


class MemoryBudget(unittest.TestCase):  # LD-45, LD-48: sum(mem_limit) <= 85 % of host RAM, both profiles
    def test_every_inventory_within_budget(self):
        for e in ENVS:
            _, hv = inventory(INV / e / "hosts.yml")
            self.assertEqual(mem_problems(hv), [], f"{e}: memory budget")

    def test_prod_lean_prod_1_declares_its_budget(self):  # a missing key must fail, not pass vacuously
        _, hv = inventory(INV / "prod-lean" / "hosts.yml")
        p1 = hv["prod-1"]
        self.assertEqual(p1.get("host_ram_gib"), 32, "prod-1 = 32 GB (LD-45)")
        self.assertTrue(p1.get("mem_limit_gib"), "prod-1: mem_limit_gib missing")
        total = sum(s["replicas"] * s["gib"] for s in p1["mem_limit_gib"].values())
        self.assertLessEqual(total, 27.2 + 1e-9, "LD-45: 85 % of 32 GiB = 27.2")
        self.assertGreater(total, 20, "budget must list the LD-45 services (about 25.9 GiB), not a stub")

    def test_budget_gate_can_fail(self):  # proves mem_problems flags over-budget and half-declared hosts
        over = {"h": {"host_ram_gib": 10, "mem_limit_gib": {"a": {"replicas": 3, "gib": 3}}}}  # 9 > 8.5
        half = {"h": {"mem_limit_gib": {"a": {"replicas": 1, "gib": 1}}}}  # limits without a RAM figure
        ok = {"h": {"host_ram_gib": 10, "mem_limit_gib": {"a": {"replicas": 2, "gib": 4}}}}  # 8 <= 8.5
        self.assertEqual(len(mem_problems(over)), 1)
        self.assertEqual(len(mem_problems(half)), 1)
        self.assertEqual(mem_problems(ok), [])


class ProfileDocs(unittest.TestCase):  # LD-48: prod-lean documented as the default
    DEFAULT_RX = r"(?is)prod-lean[^\n]{0,80}default|default[^\n]{0,80}prod-lean"

    def test_readme_and_decision_name_prod_lean_default(self):
        for p in (INFRA / "README.md", INV / "DECISION.md"):
            self.assertTrue(p.is_file(), f"{p.relative_to(ROOT)} missing")
            self.assertRegex(read(p), self.DEFAULT_RX, f"{p.relative_to(ROOT)}: must name `prod-lean` as the default")

    def test_decision_lists_scale_triggers(self):  # LD-45
        t = read(INV / "DECISION.md")
        for what, rx in (("CPU > 60 %", r"CPU\s*>\s*60\s*%"), ("RAM > 80 %", r"RAM\s*>\s*80\s*%"),
                         ("7 days", r"7\s*days"), ("DB > 150 GB", r">\s*150\s*GB"),
                         ("second lab group", r"(?i)second lab group")):
            self.assertRegex(t, rx, f"DECISION.md scale trigger: {what}")


class EnvSeparation(unittest.TestCase):  # REQ-SEC-136, AC-21.1, 02-TRD s12.1
    def env_text(self, e):
        return "\n".join(read(p) for p in sorted((INV / e).rglob("*")) if p.is_file())

    def test_each_env_uses_own_wireguard_subnet_only(self):
        for e in ENVS:
            t = self.env_text(e)
            mine = subnet_of(e)
            self.assertIn(mine, t, f"{e}: must use wg subnet {mine}x")
            for o, sub in SUBNET.items():
                if sub != mine:
                    self.assertNotIn(sub, t, f"{e}: contains {o}'s wg subnet {sub}x")

    def test_prod_wg_ips_match_trd(self):
        t = self.env_text("prod")
        for last in (11, 21, 31, 41):
            self.assertIn(f"10.77.0.{last}", t, f"prod wg_ip .{last}")

    def test_lean_hosts_have_wg_ip_in_their_env_subnet(self):
        for e in LEAN_ONLY:
            _, hv = inventory(INV / e / "hosts.yml")
            ips = [v.get("wg_ip") for v in hv.values()]
            for h, v in hv.items():
                self.assertTrue(str(v.get("wg_ip", "")).startswith(subnet_of(e)), f"{e}/{h}: wg_ip in {subnet_of(e)}x")
            self.assertEqual(len(set(ips)), len(ips), f"{e}: duplicate wg_ip")

    def test_no_public_address_shared_between_envs(self):
        seen = {}
        for e in ENVS:
            _, hv = inventory(INV / e / "hosts.yml")
            for h, v in hv.items():
                a = v.get("public_ip")
                self.assertTrue(a, f"{e}/{h}: public_ip")
                if a in seen:
                    self.fail(f"{e}/{h} and {seen[a]} share public_ip {a}")
                seen[a] = f"{e}/{h}"


class InventorySecurity(unittest.TestCase):  # 02-TRD s4 rules
    def inv_files(self):
        return [p for p in sorted(INV.rglob("*")) if p.is_file()]

    def test_secrets_never_in_inventories(self):
        self.assertTrue(self.inv_files(), "no inventory files")
        bad = []
        for p in self.inv_files():
            t = read(p)
            if re.search("PRIVATE" + " KEY-----|AGE-SECRET" + "-KEY-|ENC\\[AES256_GCM", t):
                bad.append(f"{p.relative_to(ROOT)}: key material")
            for m in re.finditer(r"(?mi)^\s*([\w.-]*(?:password|passwd|secret|token|private_key|api_key|become_pass|ssh_pass)[\w.-]*)\s*:\s*(\S.*)$", t):
                v = m.group(2).strip().strip("\"'")
                if v and not v.startswith("#"):
                    bad.append(f"{p.relative_to(ROOT)}: `{m.group(1)}` has a value")
        self.assertEqual(bad, [])

    def test_host_key_checking_never_disabled(self):
        bad = []
        for p in list(self.inv_files()) + list(PROV.rglob("*")) + list(ANS.glob("ansible.cfg")):
            if not p.is_file():
                continue
            try:
                t = read(p)
            except (UnicodeDecodeError, OSError):
                continue
            if re.search(r"(?i)host_key_checking\s*[:=]\s*(false|no|0)\b|StrictHostKeyChecking[= ]+no|UserKnownHostsFile[= ]*/dev/null|ANSIBLE_HOST_KEY_CHECKING", t):
                bad.append(str(p.relative_to(ROOT)))
        self.assertEqual(bad, [], "host key checking must stay on (s4)")

    def test_known_hosts_has_no_wildcard_trust(self):
        for e in ENVS:
            t = read(INV / e / "known_hosts")
            for ln in t.splitlines():
                ln = ln.strip()
                if ln and not ln.startswith("#"):
                    self.assertFalse(ln.startswith("*"), f"{e}/known_hosts: wildcard host entry")

    def test_ansible_cfg_if_present_is_safe(self):  # file is owned by a later task; checked once it exists
        cfg = ANS / "ansible.cfg"
        if not cfg.is_file():
            self.skipTest("ansible.cfg not yet created (not a T-02 file)")
        c = configparser.ConfigParser(interpolation=None)
        c.read_string(read(cfg))
        self.assertTrue(c.has_option("defaults", "inventory"))
        self.assertNotEqual(c.get("defaults", "host_key_checking", fallback="True").strip().lower(), "false")


class ProviderValueGrep(unittest.TestCase):  # done_when: grep check
    def test_no_provider_value_outside_allowed_paths(self):
        self.assertEqual(provider_scan(INFRA), [], "provider-specific value outside providers/ and inventories/*/hosts.yml")

    def test_scanner_flags_planted_values_and_honours_allowed_paths(self):  # proves the gate can fail
        with tempfile.TemporaryDirectory() as d:
            base = Path(d)
            files = {
                "ansible/roles/x/tasks/main.yml": "ami: " + "ec" + "2 on " + "ama" + "zonaws.com",  # flagged
                "ansible/inventories/dev/group_vars/all.yml": "region: " + "ap-south" + "-1",  # flagged
                "ansible/inventories/dev/hosts.yml": "x: " + "hetz" + "ner",  # allowed
                "ansible/inventories/dev/known_hosts": "# " + "169.254." + "169.254",  # flagged
                "providers/acme/main.tf": "provider " + "digital" + "ocean",  # allowed
                "ansible/roles/y/tasks/main.yml": "msg: plain linux vm, ubuntu 24.04",  # clean
                "tests/internal/x.py": "h = " + "hetz" + "ner",  # flagged: tests/ is not an allowed path
                "compose/supabase/envoy/cds.yaml": "type: type.google" + "apis.com/envoy.x",  # clean: protobuf type URL
                "ansible/roles/z/tasks/main.yml": "url: compute.google" + "apis.com/v1",  # flagged: hosting API
                "tests/internal/probe.sh": "curl " + "169.254." + "169.254 # must be denied",  # clean: tests/ may probe
                "compose/supabase/upstream/.env.example": "# " + "hetz" + "ner",  # clean: vendored verbatim
            }
            for rel, body in files.items():
                f = base / rel
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(body, encoding="utf-8")
            got = sorted(h.split(":")[0] for h in provider_scan(base))
            self.assertEqual(got, [
                "ansible/inventories/dev/group_vars/all.yml",
                "ansible/inventories/dev/known_hosts",
                "ansible/roles/x/tasks/main.yml",
                "ansible/roles/z/tasks/main.yml",
                "tests/internal/x.py",
            ])


class Tooling(unittest.TestCase):
    def test_yamllint_clean_on_t02_paths(self):
        paths = [str(PROV), str(INV)]
        self.assertTrue(PROV.is_dir() and INV.is_dir(), "providers/ and ansible/inventories/ must exist")
        r = subprocess.run([sys.executable, "-B", "-m", "yamllint", *paths], cwd=ROOT,
                           capture_output=True, text=True, timeout=300)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_dev_inventory_loads_in_ansible(self):  # LD-17: ansible does not run on native Windows; required when CI=true
        a = shutil.which("ansible-inventory")
        if a is None:
            if os.environ.get("CI") == "true":
                self.fail("ansible-inventory missing on CI")
            self.skipTest("SKIP ansible-inventory (CI only)")
        for e in ENVS:  # every inventory, both profiles (LD-48)
            r = subprocess.run([a, "-i", str(INV / e), "--list"], cwd=ROOT, capture_output=True, text=True, timeout=120)
            self.assertEqual(r.returncode, 0, f"{e}: " + r.stdout[-1500:] + r.stderr[-1500:])
            self.assertIn("_meta", r.stdout)


if __name__ == "__main__":
    unittest.main()
