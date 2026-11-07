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
ENVS = ("dev", "staging", "prod")
GROUPS = ("data", "app", "dr", "ops")
GVARS = ("all", "data", "app", "dr", "ops")
SUBNET = {"prod": "10.77.0.", "staging": "10.78.0.", "dev": "10.79.0."}  # 02-TRD s12.1 [CONV]
PROD_HOSTS = {"data-1", "app-1", "dr-1", "ops-1"}  # 02-TRD s3.1

# Provider-specific values: vendor names, cloud regions/instance ids, metadata endpoint, cloud disk names.
PROVIDER_RX = re.compile(
    r"amazonaws|\baws\b|\bec2\b|azure|googleapis|\bgcp\b|google[ -]cloud|digitalocean|hetzner|"
    r"linode|vultr|\bovh|alibaba|aliyun|scaleway|contabo|rackspace|"
    r"169\.254\.169\.254|\bi-[0-9a-f]{8,17}\b|"
    r"\b(?:us|eu|ap|sa|ca|me|af)-(?:north|south|east|west|central|southeast|northeast)-\d\b|/dev/xvd",
    re.I,
)


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
        if rel.startswith(("providers/", "tests/")):
            continue
        if re.fullmatch(r"ansible/inventories/[^/]+/hosts\.yml", rel):
            continue
        try:
            t = read(p)
        except (UnicodeDecodeError, OSError):
            continue
        m = PROVIDER_RX.search(t)
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
            want += [INV / e / "group_vars" / f"{g}.yml" for g in GVARS]
        self.assertEqual([str(w.relative_to(ROOT)) for w in want if not w.is_file()], [])

    def test_all_four_groups_in_every_hosts_yml(self):
        for e in ENVS:
            g, _ = inventory(INV / e / "hosts.yml")
            for grp in GROUPS:
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

    def test_every_host_has_address_and_by_id_disk(self):
        for e in ENVS:
            p = INV / e / "hosts.yml"
            _, hv = inventory(p)
            for h, v in hv.items():
                self.assertTrue(v.get("ansible_host"), f"{e}/{h}: ansible_host")
            self.assertIn("/dev/disk/by-id/", read(p), f"{e}: private disks recorded as /dev/disk/by-id names (s3.4)")

    def test_group_vars_parse_and_hold_no_host_specific_values(self):
        for e in ENVS:
            for gname in GVARS:
                p = INV / e / "group_vars" / f"{gname}.yml"
                d = load(p)
                self.assertTrue(d is None or isinstance(d, dict), f"{p.name}: must be a mapping")
                t = read(p)
                self.assertNotIn("/dev/disk/by-id/", t, f"{e}/{p.name}: disk names belong in hosts.yml only")
                self.assertNotRegex(t, r"(?m)^\s*ansible_host\s*:", f"{e}/{p.name}: addresses belong in hosts.yml only")


class EnvSeparation(unittest.TestCase):  # REQ-SEC-136, AC-21.1, 02-TRD s12.1
    def env_text(self, e):
        return "\n".join(read(p) for p in sorted((INV / e).rglob("*")) if p.is_file())

    def test_each_env_uses_own_wireguard_subnet_only(self):
        for e in ENVS:
            t = self.env_text(e)
            self.assertIn(SUBNET[e], t, f"{e}: must use wg subnet {SUBNET[e]}x")
            for o in ENVS:
                if o != e:
                    self.assertNotIn(SUBNET[o], t, f"{e}: contains {o}'s wg subnet {SUBNET[o]}x")

    def test_prod_wg_ips_match_trd(self):
        t = self.env_text("prod")
        for last in (11, 21, 31, 41):
            self.assertIn(f"10.77.0.{last}", t, f"prod wg_ip .{last}")

    def test_no_public_address_shared_between_envs(self):
        seen = {}
        for e in ENVS:
            _, hv = inventory(INV / e / "hosts.yml")
            for h, v in hv.items():
                a = v.get("ansible_host")
                if a in seen:
                    self.fail(f"{e}/{h} and {seen[a]} share ansible_host {a}")
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
        r = subprocess.run([a, "-i", str(INV / "dev"), "--list"], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout[-1500:] + r.stderr[-1500:])
        self.assertIn("_meta", r.stdout)


if __name__ == "__main__":
    unittest.main()
