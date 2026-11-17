"""T-04 tests (tester role): derived Postgres image skeleton + zz-lims.conf.j2 + pg_hba.conf.j2.

Covers 02-TRD s7.7 (parameter table, pg_hba rules), s9.1 (Dockerfile = FROM supabase/postgres@sha256 ... ;
pgBackRest is T-09, NOT here), AC-07.1 prerequisite, REQ-SEC-098 (log_parameter_max_length = 0),
07-SEC A1 (wg0-only + pg_hba per source, no ops-1 entry).
Done when: image starts with our conf.d file + pg_hba; supabase_auth_admin / authenticator /
supabase_storage_admin / pgbouncer connect; wal_level = logical; log_parameter_max_length = 0.

Static part = a pg_hba first-match simulator (the "connection matrix per role/source") + conf/Dockerfile checks.
The live part (real container) is infra/tests/integration/test_t04_live.py, CI only (LIMS_T04_LIVE=1).

Template contract (variables the templates may use; anything else renders as UNDEF<...> and FAILS):
  app_db_name, wg_ip (scalar = this host's IP, like the inventories), groups (data/app/dr/ops -> [host]),
  hostvars[host].wg_ip, db_primary_wg_ip, docker_subnets.{edge,app,auth,render,db,egress},
  archive_timeout_s, inventory_hostname. dev has groups['dr'] == [] (no dr-1 lines then).
Stdlib + jinja2 + PyYAML only. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t04_*.py" -v
"""
import ipaddress
import re
import unittest
from pathlib import Path

import jinja2

ROOT = Path(__file__).resolve().parents[3]
PG = ROOT / "infra" / "database" / "postgresql"
DOCKERFILE = ROOT / "infra" / "images" / "postgres-pgbackrest" / "Dockerfile"

WG = {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"}
SUBNETS = {"edge": "172.30.10.0/24", "app": "172.30.20.0/24", "auth": "172.30.30.0/24",
           "render": "172.30.40.0/24", "db": "172.30.50.0/24", "egress": "172.30.60.0/24"}
PUBLIC = "203.0.113.9"  # TEST-NET-3, never a real host


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF<%s>" % self._undefined_name

    __html__ = __str__


def _ctx(app_db="postgres", dr=True):
    groups = {"data": ["data-1"], "app": ["app-1"], "dr": ["dr-1"] if dr else [], "ops": ["ops-1"]}
    return {"app_db_name": app_db, "wg_ip": WG["data-1"], "groups": groups,
            "hostvars": {h: {"wg_ip": ip} for h, ip in WG.items()}, "db_primary_wg_ip": WG["data-1"],
            "docker_subnets": dict(SUBNETS), "archive_timeout_s": 60, "inventory_hostname": "data-1"}


def _find(glob):
    hits = sorted(p for p in PG.glob(glob) if p.is_file()) if PG.is_dir() else []
    return hits[0] if hits else None


def render(glob, app_db="postgres", dr=True):
    p = _find(glob)
    if p is None:
        raise AssertionError("missing file infra/database/postgresql/%s" % glob)
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
    out = env.from_string(p.read_text(encoding="utf-8")).render(**_ctx(app_db, dr))
    bad = re.findall(r"UNDEF<[^>]*>", out)
    if bad:
        raise AssertionError("%s uses variables outside the template contract: %s" % (p.name, sorted(set(bad))))
    return out


def parse_conf(text):
    """key -> [values] (quotes stripped). Detects duplicates."""
    d = {}
    for raw in text.splitlines():
        line = re.sub(r"\s+#.*$", "", raw.strip()) if not raw.strip().startswith("#") else ""
        m = re.match(r"^([A-Za-z_][\w.]*)\s*=?\s*(.+)$", line)
        if m:
            v = m.group(2).strip()
            if len(v) >= 2 and v[0] == v[-1] == "'":
                v = v[1:-1]
            d.setdefault(m.group(1).lower(), []).append(v)
    return d


def parse_hba(text):
    rules = []
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        f = line.split()
        if f[0] == "local":
            rules.append({"type": "local", "db": f[1].split(","), "user": f[2].split(","), "addr": None, "method": f[3], "raw": line})
        else:
            if "/" in f[3] or f[3] == "all" or re.match(r"^[\da-fA-F:.]+$", f[3]):
                addr, method = f[3], f[4]
            else:
                raise AssertionError("unsupported pg_hba line (use CIDR addresses): " + line)
            net = None if addr == "all" else ipaddress.ip_network(addr if "/" in addr else addr + "/32", strict=False)
            rules.append({"type": f[0], "db": f[1].split(","), "user": f[2].split(","), "addr": net, "method": method, "raw": line})
    return rules


def decide(rules, ctype, db, user, src=None):
    """First-match like PostgreSQL. Returns auth method, 'reject', or 'NOMATCH' (= rejected by server)."""
    ip = ipaddress.ip_address(src) if src else None
    for r in rules:
        if r["type"] == "local" and ctype != "local":
            continue
        if r["type"] != "local" and (ctype == "local" or r["type"] not in ("host", "hostssl", "hostnossl")):
            continue
        if r["addr"] is not None and (ip is None or ip.version != r["addr"].version or ip not in r["addr"]):
            continue
        if db == "replication":
            if "replication" not in r["db"]:
                continue
        elif "all" not in r["db"] and db not in r["db"]:  # 'all' never matches replication (PostgreSQL rule)
            continue
        if "all" not in r["user"] and user not in r["user"]:
            continue
        return r["method"]
    return "NOMATCH"


def denied(m):
    return m in ("reject", "NOMATCH")


class DockerfileTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(DOCKERFILE.is_file(), "missing infra/images/postgres-pgbackrest/Dockerfile")
        self.text = DOCKERFILE.read_text(encoding="utf-8")
        self.lines = [l.strip() for l in self.text.splitlines() if l.strip() and not l.strip().startswith("#")]

    def test_from_supabase_postgres_pinned_by_digest(self):
        froms = [l for l in self.lines if l.upper().startswith("FROM ")]
        self.assertTrue(froms, "no FROM")
        self.assertRegex(froms[-1], r"(?i)^FROM\s+(--platform=\S+\s+)?supabase/postgres@sha256:[0-9a-f]{64}(\s+AS\s+\w+)?$",
                         "final FROM must be supabase/postgres@sha256:<64 hex> (TRD s9.1)")

    def test_no_floating_tags(self):
        for l in self.lines:
            if l.upper().startswith("FROM "):
                self.assertIn("@sha256:", l, "tag-only base is not allowed: " + l)

    def test_no_pgbackrest_config_or_pass_baked(self):  # was "not installed yet"; T-09 now installs it (see T-09-tests.md)
        self.assertNotRegex(self.text.lower(), r"cipher[-_]?pass", "cipher pass must never be baked")
        for l in self.lines:
            self.assertFalse(re.match(r"(?i)^(COPY|ADD)\b(?!.*--from=).*pgbackrest\.conf", l), "conf rendered by role: " + l)

    def test_no_secrets_baked(self):
        for l in self.lines:
            self.assertNotRegex(l, r"(?i)^(ENV|ARG)\s+\w*(PASSWORD|SECRET|TOKEN|KEY)\w*\s*=\s*\S", "secret in image: " + l)

    def test_does_not_bake_our_config(self):  # config is mounted by compose (TRD s7.2), not COPYed
        for l in self.lines:
            self.assertFalse(re.match(r"(?i)^(COPY|ADD)\b.*(pg_hba|zz-lims)", l), "config must be mounted, not baked: " + l)

    def test_no_final_user_root_change_to_weaker(self):
        users = [l for l in self.lines if l.upper().startswith("USER ")]
        if users:
            self.assertNotRegex(users[-1], r"(?i)^USER\s+(root|0)(:.*)?$", "image must not end as root")


class ConfTest(unittest.TestCase):
    EXPECT = {  # 02-TRD s7.7 table (archive_command: T-09, hot_standby_feedback: standby role)
        "wal_level": "logical", "max_connections": "200", "shared_buffers": "8gb",
        "effective_cache_size": "22gb", "work_mem": "16mb", "maintenance_work_mem": "1gb",
        "random_page_cost": "1.1", "effective_io_concurrency": "200", "wal_compression": "zstd",
        "max_wal_size": "4gb", "min_wal_size": "1gb", "checkpoint_timeout": "15min",
        "checkpoint_completion_target": "0.9", "archive_mode": "on", "max_wal_senders": "10",
        "max_replication_slots": "10", "max_slot_wal_keep_size": "50gb", "wal_keep_size": "2gb",
        "idle_in_transaction_session_timeout": "60s", "log_min_duration_statement": "1000",
        "log_parameter_max_length": "0", "log_parameter_max_length_on_error": "0",
        "log_statement": "none", "auto_explain.log_min_duration": "-1",
        "password_encryption": "scram-sha-256", "ssl": "off",
    }

    def setUp(self):
        self.text = render("zz-lims.conf*")
        self.conf = parse_conf(self.text)

    def test_file_is_zz_prefixed_template(self):
        self.assertEqual(getattr(_find("zz-lims.conf*"), "name", None), "zz-lims.conf.j2")  # sorts last in conf.d -> wins

    def test_values_match_trd(self):
        for k, v in self.EXPECT.items():
            self.assertIn(k, self.conf, "%s missing in zz-lims.conf" % k)
            self.assertEqual(self.conf[k][-1].lower(), v, k)

    def test_wal_level_logical(self):  # done_when: SHOW wal_level = logical
        self.assertEqual(self.conf["wal_level"], ["logical"])

    def test_bind_parameters_never_logged(self):  # REQ-SEC-098, CV s9.2 (PHI)
        for k in ("log_parameter_max_length", "log_parameter_max_length_on_error"):
            self.assertEqual(self.conf[k], ["0"], k)
        self.assertEqual(self.conf["log_statement"], ["none"])
        self.assertEqual(self.conf["auto_explain.log_min_duration"], ["-1"])

    def test_log_line_prefix(self):
        self.assertEqual(self.conf["log_line_prefix"][-1], "%m [%p] %q%u@%d ")

    def test_archive_timeout(self):
        self.assertIn(self.conf["archive_timeout"][-1], ("60s", "60", "1min"))

    def test_no_duplicate_keys(self):  # last-wins would silently mask a wrong value
        dup = {k: v for k, v in self.conf.items() if len(v) > 1}
        self.assertFalse(dup, "duplicate settings: %s" % dup)

    def test_not_changed_keys_absent(self):
        self.assertNotIn("shared_preload_libraries", self.conf, "TRD: image default, not changed")
        self.assertNotRegex(self.text, r"(?i)alter\s+system", "config is code, no ALTER SYSTEM")

    def test_no_override_of_hba_or_network_from_image(self):
        for k in ("hba_file", "listen_addresses", "include", "include_dir", "include_if_exists"):
            self.assertNotIn(k, self.conf, "%s must stay with the image / compose (ports bind to wg IP)" % k)

    def test_no_secret_in_conf(self):
        self.assertNotRegex(self.text, r"(?i)password\s*=\s*\S|secret|token")


class HbaTest(unittest.TestCase):
    def rules(self, app_db="postgres"):
        return parse_hba(render("pg_hba.conf*", app_db))

    def test_template_name(self):
        self.assertEqual(getattr(_find("pg_hba.conf*"), "name", None), "pg_hba.conf.j2")

    def test_no_trust_md5_password_or_public_open(self):
        for r in self.rules():
            self.assertNotIn(r["method"], ("trust", "md5", "password", "ident", "ldap", "pam"), r["raw"])
            self.assertFalse(r["type"] in ("hostssl", "hostnossl"), "ssl=off: hostssl lines can never match: " + r["raw"])
            if r["addr"] is not None and r["method"] != "reject":
                self.assertTrue(r["addr"].is_private, "non-private source allowed: " + r["raw"])
                self.assertNotEqual(r["addr"].prefixlen, 0, r["raw"])

    def test_default_reject_is_last_for_v4_and_v6(self):
        rules = self.rules()
        tail = rules[-2:]
        for ver in (4, 6):
            hit = [r for r in tail if r["method"] == "reject" and r["addr"] and r["addr"].version == ver
                   and r["addr"].prefixlen == 0 and r["db"] == ["all"] and r["user"] == ["all"]]
            self.assertTrue(hit, "last two entries must be 'host all all 0.0.0.0/0 reject' and '::/0 reject'")

    def test_dev_without_dr_group_renders_no_dr_lines(self):  # dev inventory: dr: {}
        rules = parse_hba(render("pg_hba.conf*", dr=False))
        self.assertNotIn(WG["dr-1"], render("pg_hba.conf*", dr=False))
        self.assertTrue(denied(decide(rules, "host", "replication", "lims_replicator", WG["dr-1"])))
        self.assertTrue(denied(decide(rules, "host", "postgres", "lims_audit_ship", WG["dr-1"])))
        self.assertEqual(decide(rules, "host", "postgres", "authenticator", WG["app-1"]), "scram-sha-256")
        for ver, last in ((4, rules[-2]), (6, rules[-1])):
            self.assertEqual((last["method"], last["addr"].version, last["addr"].prefixlen), ("reject", ver, 0))

    def test_ops1_has_no_entry(self):  # TRD s7.7 / s5.5, AC-08 (ops-1 rejected)
        txt = render("pg_hba.conf*")
        self.assertNotIn(WG["ops-1"], txt)
        self.assertNotIn("ops-1", re.sub(r"#.*", "", txt))

    def test_local_socket_not_trust(self):
        m = decide(self.rules(), "local", "postgres", "supabase_admin")
        self.assertIn(m, ("peer", "scram-sha-256"))

    def test_bridge_entry_exists_and_is_narrow(self):
        br = [r for r in self.rules() if r["type"] == "host" and r["addr"] and r["method"] == "scram-sha-256"
              and r["db"] == ["all"] and r["user"] == ["all"] and r["addr"].prefixlen < 32]
        self.assertEqual(len(br), 1, "exactly one docker-bridge 'host all all <subnet> scram-sha-256' entry")
        net = br[0]["addr"]
        self.assertGreaterEqual(net.prefixlen, 16)
        for ip in WG.values():
            self.assertNotIn(ipaddress.ip_address(ip), net, "bridge entry must not cover wg0 hosts")


class ConnectionMatrixTest(unittest.TestCase):
    """role x source x database matrix, evaluated on the rendered pg_hba (first match wins)."""

    APP_DBS = ("postgres", "lims_app")  # default + a custom app_db_name (AC-07.2: same value everywhere)
    INTERNAL = ("supabase_auth_admin", "authenticator", "supabase_storage_admin", "pgbouncer")
    BRIDGE_SRC = "172.30.50.5"

    def bridge_source(self, rules):
        for r in rules:
            if r["type"] == "host" and r["addr"] and r["db"] == ["all"] and r["user"] == ["all"] \
               and r["method"] == "scram-sha-256" and r["addr"].prefixlen < 32:
                return str(next(r["addr"].hosts()))
        raise AssertionError("no docker bridge entry")

    def test_internal_roles_connect_from_app1_wg_ip(self):  # done_when
        for app_db in self.APP_DBS:
            rules = parse_hba(render("pg_hba.conf*", app_db))
            for role in self.INTERNAL:
                for db in (app_db, "postgres", "_supabase"):
                    self.assertEqual(decide(rules, "host", db, role, WG["app-1"]), "scram-sha-256", (app_db, role, db))

    def test_internal_roles_connect_from_docker_bridge(self):  # pgbouncer + local services
        rules = parse_hba(render("pg_hba.conf*"))
        src = self.bridge_source(rules)
        for role in self.INTERNAL:
            self.assertEqual(decide(rules, "host", "postgres", role, src), "scram-sha-256", role)

    def test_internal_roles_local_socket(self):
        rules = parse_hba(render("pg_hba.conf*"))
        for role in self.INTERNAL:
            self.assertIn(decide(rules, "local", "postgres", role), ("peer", "scram-sha-256"), role)

    def test_ops1_rejected_for_every_role_and_db(self):  # T-08 gate relies on it, 07-SEC A1
        rules = parse_hba(render("pg_hba.conf*"))
        for role in self.INTERNAL + ("lims_migrator", "lims_api", "lims_replicator", "lims_audit_ship", "postgres", "supabase_admin"):
            for db in ("postgres", "replication", "_supabase"):
                self.assertTrue(denied(decide(rules, "host", db, role, WG["ops-1"])), (role, db))

    def test_public_and_unknown_sources_rejected(self):
        rules = parse_hba(render("pg_hba.conf*"))
        for src in (PUBLIC, "10.79.0.99", "172.30.60.5", "172.30.10.10", "2001:db8::1"):
            for role in self.INTERNAL + ("lims_replicator", "lims_audit_ship"):
                for db in ("postgres", "replication"):
                    self.assertTrue(denied(decide(rules, "host", db, role, src)), (src, role, db))

    def test_dr1_only_replication_and_audit_ship(self):
        for app_db in self.APP_DBS:
            rules = parse_hba(render("pg_hba.conf*", app_db))
            dr = WG["dr-1"]
            self.assertEqual(decide(rules, "host", "replication", "lims_replicator", dr), "scram-sha-256")
            self.assertEqual(decide(rules, "host", app_db, "lims_audit_ship", dr), "scram-sha-256")
            # everything else from dr-1 is closed
            self.assertTrue(denied(decide(rules, "host", app_db, "lims_replicator", dr)))
            self.assertTrue(denied(decide(rules, "host", "replication", "lims_audit_ship", dr)))
            self.assertTrue(denied(decide(rules, "host", "_supabase", "lims_audit_ship", dr)))
            for role in self.INTERNAL + ("lims_migrator", "lims_api", "postgres", "supabase_admin"):
                self.assertTrue(denied(decide(rules, "host", app_db, role, dr)), role)
                self.assertTrue(denied(decide(rules, "host", "replication", role, dr)), role)

    def test_audit_ship_follows_app_db_name(self):  # AC-07.2
        rules = parse_hba(render("pg_hba.conf*", "lims_app"))
        self.assertTrue(denied(decide(rules, "host", "postgres", "lims_audit_ship", WG["dr-1"])),
                        "pg_hba hard-codes the db name instead of app_db_name")

    def test_replication_never_from_app1_or_bridge(self):
        rules = parse_hba(render("pg_hba.conf*"))
        for src in (WG["app-1"], self.bridge_source(rules)):
            for role in ("lims_replicator", "lims_audit_ship") + self.INTERNAL:
                self.assertTrue(denied(decide(rules, "host", "replication", role, src)), (src, role))


if __name__ == "__main__":
    unittest.main()
