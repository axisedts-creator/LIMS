"""T-07 tests (tester role): PgBouncer config (pgbouncer.ini.j2) + override.data.yml wiring + lims_api auth.

Covers 02-TRD s7.6 (values), s7.2 (override.data.yml mounts the ini), AC-07.1 (supavisor absent, pgbouncer in
transaction mode, PgBouncer >= 1.21), AC-07.2 (database entry uses app_db_name), AC-07.3 (prerequisite: transaction
pooling + server-connection reuse; the tenant-isolation behaviour is C0's AC-0D-2.3 test, run on staging),
07-SEC A1 (PgBouncer caps connection exhaustion, wg-IP-only bind, no secrets in the ini).
LD-45 (2026-11-07, lean/full profiles): the rendered ini must be identical under both host-name profiles
(no host names in it; PgBouncer reaches Postgres by the compose service name `db`).

Template contract: only `app_db_name` (and `inventory_hostname`) may be used; anything else renders as UNDEF<..> and FAILS.
Assumption (documented in the tests below): PgBouncer ini comments are whole-line only (; or #), because PgBouncer
reads everything after `=` as the value, so the TRD's trailing `; ...` comments must NOT be rendered.
Decision under test (TRD s7.2 "env vs ini"): the INI wins; the auth credentials of the `pgbouncer` auth_user live in an
auth_file mounted from /run/lims/secrets (never in the repo), and lims_api is resolved via auth_query or listed there.
Stdlib + jinja2 + PyYAML only. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t07_*.py" -v
"""
import re
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
PGB = ROOT / "infra" / "database" / "pgbouncer"
SUPA = ROOT / "infra" / "compose" / "supabase"
UP = SUPA / "upstream"
OVERRIDE = SUPA / "override.data.yml"
LOCK = UP / "UPSTREAM.lock"
DATA_LAYERS = [UP / "docker-compose.yml", UP / "docker-compose.pgbouncer.yml", OVERRIDE]


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF<%s>" % self._undefined_name

    __html__ = __str__


def render(app_db="postgres", host="data-1"):
    hits = sorted(p for p in PGB.glob("pgbouncer.ini*") if p.is_file()) if PGB.is_dir() else []
    if not hits:
        raise AssertionError("missing file infra/database/pgbouncer/pgbouncer.ini.j2")
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
    out = env.from_string(hits[0].read_text(encoding="utf-8")).render(app_db_name=app_db, inventory_hostname=host)
    bad = re.findall(r"UNDEF<[^>]*>", out)
    if bad:
        raise AssertionError("pgbouncer.ini.j2 uses variables outside the template contract: %s" % sorted(set(bad)))
    return out


def parse_ini(text):
    """-> {section: {key: [values]}}; whole-line comments (; or #) dropped, nothing else stripped."""
    secs, cur = {}, None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in ";#":
            continue
        m = re.match(r"^\[([^\]]+)\]$", line)
        if m:
            cur = secs.setdefault(m.group(1), {})
            continue
        m = re.match(r"^([^=\s]+)\s*=\s*(.*)$", line)
        if m and cur is not None:
            cur.setdefault(m.group(1).lower(), []).append(m.group(2).strip())
    return secs


def pgb(app_db="postgres", host="data-1"):
    secs = parse_ini(render(app_db, host))
    if "pgbouncer" not in secs:
        raise AssertionError("no [pgbouncer] section in the rendered ini")
    return secs


def one(sec, key):
    vals = sec.get(key)
    if not vals:
        raise AssertionError("missing key %s" % key)
    if len(vals) != 1:
        raise AssertionError("duplicate key %s: %s" % (key, vals))
    return vals[0]


class _ComposeLoader(yaml.SafeLoader):
    pass


def _passthrough(loader, node):
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_scalar(node)


_ComposeLoader.add_constructor("!reset", _passthrough)
_ComposeLoader.add_constructor("!override", _passthrough)


def load_compose(path):
    p = Path(path)
    if not p.is_file():
        raise AssertionError("missing file %s" % p)
    return yaml.load(p.read_text(encoding="utf-8"), Loader=_ComposeLoader)


def pgb_service():
    svc = (load_compose(OVERRIDE).get("services") or {}).get("pgbouncer")
    if not isinstance(svc, dict):
        raise AssertionError("override.data.yml has no services.pgbouncer")
    return svc


def mounts(svc):
    """-> [(source, target, mode)] from short-syntax volume strings."""
    out = []
    for v in svc.get("volumes") or []:
        parts = str(v).split(":")
        # host side may contain ${VAR:?msg}; none of our mounts do, so a plain split is fine here
        out.append((parts[0], parts[1] if len(parts) > 1 else "", parts[2] if len(parts) > 2 else ""))
    return out


class RenderContractTest(unittest.TestCase):
    def test_template_exists_and_renders(self):
        self.assertIn("[pgbouncer]", render())

    def test_no_trailing_comments_on_value_lines(self):
        # PgBouncer takes everything after '=' as the value: "pool_mode = transaction ; 04 S8" would be invalid.
        for line in render().splitlines():
            s = line.strip()
            if s and s[0] not in ";#[" and "=" in s:
                self.assertNotRegex(s, r"\s[;#]", "inline comment would end up in the value: %r" % s)

    def test_identical_under_lean_and_full_profiles(self):
        # LD-45: no host names in the ini; lean (prod-1) and full (data-1) render the same bytes.
        self.assertEqual(render("postgres", "data-1"), render("postgres", "prod-1"))
        self.assertEqual(render("postgres", "data-1"), render("postgres", "dev-1"))


class PoolValuesTest(unittest.TestCase):
    EXPECT = {  # 02-TRD s7.6
        "listen_port": "6432", "pool_mode": "transaction", "max_client_conn": "500", "default_pool_size": "40",
        "reserve_pool_size": "10", "reserve_pool_timeout": "3", "max_prepared_statements": "200",
        "auth_type": "scram-sha-256", "query_wait_timeout": "30", "server_idle_timeout": "600",
        "server_lifetime": "3600", "idle_transaction_timeout": "60",
        "ignore_startup_parameters": "extra_float_digits", "log_connections": "0", "log_disconnections": "0",
    }

    def test_values_match_trd_7_6(self):
        sec = pgb()["pgbouncer"]
        for k, v in self.EXPECT.items():
            with self.subTest(key=k):
                self.assertEqual(one(sec, k), v)

    def test_pool_mode_is_transaction_and_prepared_statements_enabled(self):
        sec = pgb()["pgbouncer"]
        self.assertEqual(one(sec, "pool_mode"), "transaction")  # AC-07.1
        self.assertGreater(int(one(sec, "max_prepared_statements")), 0)  # 0 = disabled; must be > 0 (done_when)

    def test_pool_covers_two_api_replicas(self):
        sec = pgb()["pgbouncer"]
        self.assertGreaterEqual(int(one(sec, "default_pool_size")), 2 * 20)  # 2 replicas x LIMS_CORE_DB_POOL_MAX 20
        self.assertGreaterEqual(int(one(sec, "max_client_conn")), 500)  # burst 500 clients (TRD s14)

    def test_listens_inside_container_only_restricted_by_host_binding(self):
        sec = pgb()["pgbouncer"]
        self.assertEqual(one(sec, "listen_addr"), "0.0.0.0")  # host side binds ${WG_IP}:6432 (override test below)

    def test_admin_console_limited_to_pgbouncer_role(self):
        sec = pgb()["pgbouncer"]
        self.assertEqual(one(sec, "admin_users"), "pgbouncer")
        self.assertEqual(one(sec, "stats_users"), "pgbouncer")
        self.assertNotIn("lims_api", " ".join(sec.get("admin_users", []) + sec.get("stats_users", [])))

    def test_no_weak_auth_and_no_connection_logging(self):
        sec = pgb()["pgbouncer"]
        self.assertEqual(one(sec, "auth_type"), "scram-sha-256")  # never trust/plain/md5/any
        self.assertEqual(one(sec, "log_connections"), "0")  # 07-SEC: no usernames/addresses churn in logs
        self.assertEqual(one(sec, "log_disconnections"), "0")


class DatabasesTest(unittest.TestCase):
    def test_entry_uses_app_db_name(self):  # AC-07.2
        for name in ("postgres", "lims_app"):
            with self.subTest(app_db=name):
                dbs = pgb(name)["databases"]
                self.assertEqual(list(dbs), [name], "exactly one database entry, named app_db_name")
                conn = dbs[name][0]
                self.assertRegex(conn, r"\bhost=db\b")
                self.assertRegex(conn, r"\bport=5432\b")
                self.assertRegex(conn, r"\bdbname=%s\b" % re.escape(name))

    def test_no_hardcoded_default_db_when_renamed(self):
        out = render("lims_app")
        self.assertNotIn("postgres", parse_ini(out)["databases"].get("lims_app", [""])[0])
        self.assertNotRegex(out, r"(?m)^\s*postgres\s*=")

    def test_no_wildcard_fallback_database(self):
        # "* = host=db" would let any client name any database through the pooler.
        self.assertNotIn("*", pgb()["databases"])


class AuthTest(unittest.TestCase):
    """lims_api must authenticate (done_when). Either auth_query resolves it (auth_user=pgbouncer + auth_file holding
    pgbouncer's own secret) or auth_file lists it. Secrets never live in the ini or the repo."""

    def test_auth_file_configured_and_absolute(self):
        sec = pgb()["pgbouncer"]
        self.assertTrue(one(sec, "auth_file").startswith("/"), "auth_file must be an absolute container path")

    def test_auth_query_requires_auth_user_pgbouncer(self):
        sec = pgb()["pgbouncer"]
        if "auth_query" in sec:
            self.assertEqual(one(sec, "auth_query"), "SELECT * FROM pgbouncer.get_auth($1)")
            self.assertEqual(one(sec, "auth_user"), "pgbouncer")  # without auth_user the query is never run

    def test_no_secret_material_in_ini(self):
        out = render()
        self.assertNotRegex(out, r"SCRAM-SHA-256\$", "SCRAM verifier in the ini")
        self.assertNotRegex(out, r"(?i)\bmd5[0-9a-f]{32}\b", "md5 hash in the ini")
        self.assertNotRegex(out, r"(?im)^\s*(server_)?password\s*=", "password key in the ini")
        self.assertNotRegex(out, r"(?i)\bpassword=", "password in a connection string")

    def test_userlist_is_not_in_the_repo(self):
        stray = [p for p in PGB.rglob("*") if p.is_file() and re.search(r"userlist|auth_?file", p.name, re.I)] if PGB.is_dir() else []
        self.assertEqual(stray, [], "credential files must be rendered from secrets at deploy time, not committed")


class OverrideDataTest(unittest.TestCase):
    def test_pgbouncer_mounts_rendered_ini_readonly(self):
        want = [m for m in mounts(pgb_service()) if m[1] == "/etc/pgbouncer/pgbouncer.ini"]
        self.assertEqual(len(want), 1, "override.data.yml must mount the rendered ini at /etc/pgbouncer/pgbouncer.ini")
        src, _, mode = want[0]
        self.assertTrue(src.replace("\\", "/").endswith("database/pgbouncer/pgbouncer.ini"), src)
        self.assertEqual(mode, "ro")

    def test_auth_file_mounted_from_secrets_tmpfs(self):
        auth_file = one(pgb()["pgbouncer"], "auth_file")
        hit = [m for m in mounts(pgb_service()) if m[1] == auth_file]
        self.assertEqual(len(hit), 1, "nothing mounted at auth_file %s" % auth_file)
        self.assertTrue(hit[0][0].startswith("/run/lims/secrets/"), "auth_file source must be under /run/lims/secrets/: %s" % hit[0][0])
        self.assertEqual(hit[0][2], "ro")

    def test_published_port_is_wg_ip_only(self):
        ports = pgb_service().get("ports")
        self.assertEqual(ports, ["${WG_IP:?WG_IP (data-1 wg address) required}:6432:6432"])

    def test_no_literal_secrets_in_pgbouncer_environment(self):
        env = pgb_service().get("environment") or {}
        items = env.items() if isinstance(env, dict) else [str(e).split("=", 1) + [""] for e in env]
        for k, *v in items:
            val = str(v[0]) if v else ""
            if re.search(r"PASS|SECRET|TOKEN", str(k), re.I):
                self.assertRegex(val, r"^(\$\{[A-Z_]+[^}]*\})?$", "literal secret in environment %s" % k)

    def test_image_pinned_by_digest_and_matches_lock(self):
        image = pgb_service().get("image", "")
        m = re.search(r"@sha256:([0-9a-f]{64})$", image)
        self.assertTrue(m, "image not pinned by digest: %s" % image)
        lock = yaml.safe_load(LOCK.read_text(encoding="utf-8"))
        self.assertIn(m.group(1), str(lock["images"]["pgbouncer"]["digest"]))

    def test_pgbouncer_version_at_least_1_21(self):  # AC-07.1; protocol-level prepared statements need >= 1.21
        lock = yaml.safe_load(LOCK.read_text(encoding="utf-8"))
        tag = str(lock["images"]["pgbouncer"]["tag"])
        m = re.match(r"v?(\d+)\.(\d+)", tag)
        self.assertTrue(m, tag)
        self.assertGreaterEqual((int(m.group(1)), int(m.group(2))), (1, 21))


class SupavisorAbsentTest(unittest.TestCase):
    def test_every_data_layer_removes_or_never_defines_supavisor(self):  # AC-07.1
        # upstream compose defines it; the pgbouncer override and ours reset it to null (`!reset null` -> "null"/None).
        reset = [p.name for p in DATA_LAYERS[1:] if (load_compose(p).get("services") or {}).get("supavisor", "x") in (None, "null", "")]
        self.assertIn("docker-compose.pgbouncer.yml", reset)
        self.assertIn("override.data.yml", reset, "override.data.yml must keep `supavisor: !reset null`")

    def test_nothing_in_data_layers_republishes_supavisor_ports(self):
        for p in DATA_LAYERS[1:]:
            txt = p.read_text(encoding="utf-8")
            self.assertNotRegex(txt, r"(?i)POOLER_PROXY_PORT_SESSION|:5432:5432.*supavisor", p.name)


if __name__ == "__main__":
    unittest.main()
