"""T-12 tests (tester role): streaming standby on dr-1 (CR-C1-002 accepted -> `lims_replicator`), slot bounded, lag metric.

Covers 02-TRD s7.7 (max_slot_wal_keep_size 50GB, hot_standby_feedback off on standby), s9.5, s11 (`StandbyLagHigh`),
03-APP-FLOW s3.3 (dr-1 unreachable -> slot invalidated, data-1 protected), AC-22.1 prerequisite, AC-12.3 (dr-1 holds no
cipher pass), 07-SEC (secrets on tmpfs, no_log), 06-PLAN row T-12. LD-45: no host names in role/template; `lean` has no hot standby.

NOT provable here (marked in .orchestra/notes/T-12-tests.md): a running standby, replay lag under real load, a real
link-cut and slot invalidation (infra/tests/integration/test_t12_live.py, LIMS_T12_LIVE=1 with PostgreSQL 17 binaries).
These tests prove the committed artefacts and the lag-metric script behaviour with a faked `psql`.

CONTRACTS where the spec is silent (writer must meet them; ambiguity -> dispute, not a silent change):
 * SEEDING = CR-T09 option (a): `pg_basebackup` over wg0 as `lims_replicator` (replication slot `dr1`), NO pgBackRest on dr-1,
   NO `restore_command`, NO cipher pass in the role (AC-12.3 stays as written). Gaps are closed by re-seeding (03-APP-FLOW s3.3).
   If the lead chose (b)/(c) instead, file a dispute with the ruling; the AC-12.3 / restore_command tests then change.
 * infra/database/standby/standby.conf.j2: PostgreSQL conf lines `key = value`. Render vars: groups, hostvars[h].wg_ip
   (+ optional standby_primary_port, default 5432). Primary host = groups['data'][0] wg_ip, NEVER db_primary_wg_ip (that var
   points at dr-1 after a promotion). Secret only via `passfile=` on tmpfs (/run/...); never `password=`.
 * Role `standby` (infra/ansible/roles/standby), play `hosts: dr` in site.yml after the pgBackRest play. Defaults define
   `standby_enabled`: true only when groups['dr'] is non-empty AND `topology_profile` (inventory var, 'full'|'lean', default
   'full') is not 'lean'. [ASSUMPTION: LD-45 says the profile is "selected in the inventory" but gives no variable name; if the
   inventory uses another name, dispute.] In `lean` the `dr` group may hold the backup host (repo2/replica) which must NOT get a standby.
 * infra/ansible/roles/standby/files/lims-standby-metrics.sh (bash): env TEXTFILE_DIR; `psql` taken from PATH, called with -A -t
   -F'|' and ONE query that returns ONE row `in_recovery|replay_lag_seconds` (t/f | number or empty when unknown). Writes
   $TEXTFILE_DIR/*.prom: lims_ops_standby_up (1 query ok / 0 psql failed), lims_ops_standby_in_recovery (1/0),
   lims_ops_standby_replay_lag_seconds (only when in recovery AND the lag is known - never 0 for unknown). A failed psql
   leaves NO stale lag line. File replaced atomically (no temp file left in TEXTFILE_DIR).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t12_*.py" -v
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
ROLE = ROOT / "infra" / "ansible" / "roles" / "standby"
STANDBY_J2 = ROOT / "infra" / "database" / "standby" / "standby.conf.j2"
ZZ_J2 = ROOT / "infra" / "database" / "postgresql" / "zz-lims.conf.j2"
HBA_J2 = ROOT / "infra" / "database" / "postgresql" / "pg_hba.conf.j2"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
SCRIPT = ROLE / "files" / "lims-standby-metrics.sh"
SCHEMAS = ROOT / "infra" / "secrets" / "schema"
HOSTNAME_RE = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")

PROFILES = {  # LD-45
    "full": {"hosts": {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"},
             "groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]}},
    "lean": {"hosts": {"prod-1": "10.79.0.11", "backup-1": "10.79.0.15"},
             "groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": ["backup-1"]}},
    "dev": {"hosts": {"dev-1": "10.79.0.11"},
            "groups": {"data": ["dev-1"], "app": ["dev-1"], "ops": ["dev-1"], "dr": []}},
}


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


ENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)


def ctx(profile="full", **extra):
    p = PROFILES[profile]
    c = {"groups": p["groups"], "hostvars": {h: {"wg_ip": ip} for h, ip in p["hosts"].items()},
         "db_primary_wg_ip": p["hosts"][p["groups"]["data"][0]], "app_db_name": "postgres", "archive_timeout_s": 60,
         "docker_subnets": {"db": "172.30.50.0/24"}, "group_names": ["dr"]}
    c.update(extra)
    return c


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def uncommented(text):
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("#"))


def settings(text):
    """PostgreSQL conf text -> {key: value-string} (last wins, quotes stripped, inline comments dropped)."""
    out = {}
    for line in uncommented(text).splitlines():
        m = re.match(r"^\s*([a-z_.]+)\s*=\s*(.+?)\s*$", line)
        if m:
            v = re.sub(r"\s+#.*$", "", m.group(2)).strip()
            out[m.group(1)] = v[1:-1] if len(v) > 1 and v[0] == v[-1] == "'" else v
    return out


def render_standby(profile="full", **extra):
    return ENV.from_string(need(STANDBY_J2)).render(**ctx(profile, **extra))


def role_files():
    if not ROLE.is_dir():
        raise AssertionError("missing dir infra/ansible/roles/standby")
    files = {p.relative_to(ROLE).as_posix(): p.read_text(encoding="utf-8") for p in sorted(ROLE.rglob("*")) if p.is_file()}
    if not files:
        raise AssertionError("roles/standby is empty")
    return files


def bytes_of(v):
    m = re.fullmatch(r"(-?\d+)\s*([kKMGT]?B?)", v.strip())
    if not m:
        raise AssertionError("unparsable size %r" % v)
    mult = {"": 1, "B": 1, "KB": 1 << 10, "MB": 1 << 20, "GB": 1 << 30, "TB": 1 << 40}
    return int(m.group(1)) * mult[m.group(2).upper() if m.group(2).upper() in mult else "B"]


def seconds_of(v):
    m = re.fullmatch(r"(-?\d+)\s*(ms|s|min|h)?", v.strip())
    if not m:
        raise AssertionError("unparsable duration %r" % v)
    return int(m.group(1)) * {None: 0.001, "ms": 0.001, "s": 1, "min": 60, "h": 3600}[m.group(2)]


# ---------------------------------------------------------------- standby.conf.j2
class StandbyConfTest(unittest.TestCase):
    def setUp(self):
        self.raw = need(STANDBY_J2)
        self.out = render_standby()
        self.s = settings(self.out)

    def test_conninfo_points_at_the_data_host_as_lims_replicator(self):  # TRD s9.5
        ci = self.s.get("primary_conninfo", "")
        self.assertIn("host=10.79.0.11", ci)
        self.assertRegex(ci, r"\bport=5432\b")
        self.assertRegex(ci, r"\buser=lims_replicator\b")
        self.assertNotIn("UNDEF_", self.out)

    def test_primary_host_is_not_db_primary_wg_ip(self):  # after promotion db_primary_wg_ip == dr-1: the standby must not point at itself
        out = render_standby(db_primary_wg_ip="10.79.0.13")
        self.assertIn("host=10.79.0.11", settings(out)["primary_conninfo"])
        self.assertNotIn("host=10.79.0.13", out)

    def test_host_comes_from_inventory_not_hardcoded(self):  # LD-45
        self.assertIsNone(HOSTNAME_RE.search(uncommented(self.raw)), "host name hard-coded")
        self.assertNotRegex(uncommented(self.raw), r"\b\d{1,3}(\.\d{1,3}){3}\b", "IP literal in template")
        out = render_standby("lean")
        self.assertIn("host=10.79.0.11", settings(out)["primary_conninfo"])

    def test_port_overridable_default_5432(self):  # lets the live test run on a scratch port
        self.assertRegex(settings(render_standby(standby_primary_port=55432))["primary_conninfo"], r"\bport=55432\b")

    def test_no_password_in_the_template_passfile_on_tmpfs(self):  # 07-SEC: secrets only on tmpfs
        ci = self.s["primary_conninfo"]
        self.assertNotRegex(ci, r"\bpassword\s*=", "password in conninfo (visible in pg_settings / ps)")
        self.assertRegex(ci, r"\bpassfile=/run/", "passfile must live on tmpfs under /run/")
        self.assertNotRegex(self.out, r"(?i)password\s*=\s*\S", "no password anywhere")

    def test_slot_is_dr1(self):  # TRD s9.5
        self.assertEqual(self.s.get("primary_slot_name"), "dr1")

    def test_hot_standby_on_feedback_off(self):  # TRD s7.7 [CONV]: drill queries must not bloat/stall the primary
        self.assertEqual(self.s.get("hot_standby"), "on")
        self.assertEqual(self.s.get("hot_standby_feedback"), "off")

    def test_no_pgbackrest_no_restore_command_no_cipher_on_dr(self):  # CR-T09 (a), AC-12.3
        self.assertNotIn("pgbackrest", self.raw.lower())
        self.assertNotIn("restore_command", uncommented(self.raw))
        self.assertNotRegex(self.raw.lower(), r"cipher")

    def test_no_delay_no_recovery_target_no_auto_promote(self):  # replay lag < 60 s; a standby must not stop or promote itself
        for k in self.s:
            self.assertFalse(k.startswith("recovery_target"), k)
        self.assertNotIn("promote_trigger_file", self.s)
        self.assertIn(self.s.get("recovery_min_apply_delay", "0"), ("0", "0s", "0ms", "0min"))

    def test_replay_stall_bounds_lag_below_60s(self):  # done_when lag < 60 s while a drill query runs on the standby
        v = self.s.get("max_standby_streaming_delay")
        self.assertIsNotNone(v, "set max_standby_streaming_delay explicitly (default 30s, -1 = replay stalls forever)")
        self.assertTrue(0 < seconds_of(v) <= 55, "%s would allow lag >= 60 s" % v)

    def test_dead_link_detected(self):  # link-cut: wal_receiver_timeout 0 = a cut link is never noticed
        v = self.s.get("wal_receiver_timeout")
        self.assertIsNotNone(v, "set wal_receiver_timeout explicitly")
        self.assertTrue(0 < seconds_of(v) <= 60, v)

    def test_standby_capacity_not_below_primary(self):  # PG refuses to start a hot standby with lower max_connections/wal_senders
        prim = settings(need(ZZ_J2))
        for k in ("max_connections", "max_wal_senders"):
            self.assertIn(k, self.s, "%s must be set on the standby (image default 100/10 < primary)" % k)
            self.assertGreaterEqual(int(self.s[k]), int(prim[k]), k)

    def test_managed_by_ansible_header_and_cites_decisions(self):
        self.assertIn("Managed by Ansible", self.raw)
        self.assertIn("LD-45", self.raw)


# ---------------------------------------------------------------- primary side: slot bounded
class PrimarySlotBoundTest(unittest.TestCase):
    def setUp(self):
        self.s = settings(need(ZZ_J2))

    def test_max_slot_wal_keep_size_finite_and_at_most_50gb(self):  # done_when; -1 = unbounded = data-1 fills
        v = bytes_of(self.s["max_slot_wal_keep_size"])
        self.assertTrue(0 < v <= 50 << 30, self.s["max_slot_wal_keep_size"])

    def test_wal_keep_size_finite_and_small(self):
        v = bytes_of(self.s["wal_keep_size"])
        self.assertTrue(0 <= v <= 4 << 30)

    def test_enough_slots_and_senders_for_standby_plus_audit(self):
        self.assertGreaterEqual(int(self.s["max_replication_slots"]), 2)
        self.assertGreaterEqual(int(self.s["max_wal_senders"]), 3)

    def test_primary_does_not_take_feedback_and_keeps_archiving(self):  # archive is the guarantee (TRD s9.4)
        self.assertNotEqual(self.s.get("hot_standby_feedback"), "on")
        self.assertEqual(self.s["archive_mode"], "on")

    def test_hba_admits_only_lims_replicator_from_the_dr_host_with_scram(self):  # 07-SEC; CR-C1-002
        out = ENV.from_string(need(HBA_J2)).render(**ctx("full"))
        rep = [l.split() for l in out.splitlines() if l.strip() and not l.startswith("#") and l.split()[1] == "replication"]
        self.assertEqual(rep, [["host", "replication", "lims_replicator", "10.79.0.13/32", "scram-sha-256"]])


# ---------------------------------------------------------------- role + play wiring (static)
class RoleStaticTest(unittest.TestCase):
    def setUp(self):
        self.files = role_files()
        self.code = uncommented("\n".join(self.files.values()))

    def test_role_has_defaults_tasks_and_valid_yaml(self):
        for f in ("defaults/main.yml", "tasks/main.yml"):
            self.assertIn(f, self.files)
        for f, t in self.files.items():
            if f.endswith((".yml", ".yaml")):
                yaml.safe_load(t)

    def test_site_yml_runs_role_on_dr_only_after_pgbackrest(self):
        plays = yaml.safe_load(need(SITE))
        hit = [(i, p) for i, p in enumerate(plays) if "standby" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertEqual(len(hit), 1, "exactly one play applies role standby")
        i, play = hit[0]
        self.assertEqual(str(play["hosts"]).strip(), "dr", "standby must never touch data/app/ops")
        self.assertTrue(play.get("become"))
        pg = [j for j, p in enumerate(plays) if "pgbackrest" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertTrue(pg and i > pg[0], "standby play after the pgBackRest play (T-09 dependency)")

    def _enabled(self, profile, **extra):
        d = yaml.safe_load(need(ROLE / "defaults" / "main.yml"))
        self.assertIn("standby_enabled", d, "defaults must define standby_enabled (LD-45)")
        v = d["standby_enabled"]
        c = ctx(profile, **extra)
        return str(ENV.from_string(v).render(**c)).strip().lower() == "true" if isinstance(v, str) else bool(v)

    def test_enabled_only_in_full_profile_with_a_dr_host(self):  # LD-45: no hot standby in lean
        self.assertTrue(self._enabled("full", topology_profile="full"))
        # LD-45: fail closed. `lean` is the prod default and its `dr` group is backup-1.
        try:
            on = self._enabled("full")
        except Exception:  # an explicit failure on a missing var is also closed
            on = False
        self.assertFalse(on, "inventory without topology_profile must NOT enable a standby (LD-45 fail closed)")
        self.assertFalse(self._enabled("lean", topology_profile="lean"), "lean: backup host in `dr` must not get a standby")
        self.assertFalse(self._enabled("dev"), "dev: empty dr group")
        c = dict(ctx("full", topology_profile="full"), groups={**PROFILES["full"]["groups"], "dr": []})
        d = yaml.safe_load(need(ROLE / "defaults" / "main.yml"))["standby_enabled"]
        self.assertNotEqual(str(ENV.from_string(d).render(**c)).strip().lower(), "true", "full but no dr host")

    def test_missing_topology_profile_is_asserted(self):  # LD-45 review item 1
        t = need(ROLE / "tasks" / "main.yml")
        self.assertRegex(t, r"topology_profile")
        self.assertRegex(t, r"ansible\.builtin\.assert|\bassert:", "tasks must assert topology_profile is defined and in [full, lean]")

    def test_all_work_is_gated_on_standby_enabled(self):  # empty dr / lean = installs nothing, starts nothing
        tasks = yaml.safe_load(need(ROLE / "tasks" / "main.yml"))
        self.assertTrue(tasks)
        gated = lambda t: "standby_enabled" in str(t.get("when", ""))
        early_exit = any(("ansible.builtin.meta" in t or "meta" in t) and gated(t) and "end_host" in str(t) for t in tasks)
        if not early_exit:
            for t in tasks:
                if "ansible.builtin.set_fact" in t or "set_fact" in t:
                    continue
                self.assertTrue(gated(t), "task not gated on standby_enabled: %s" % t.get("name"))

    def test_no_literal_host_names_or_ips_and_cites_decisions(self):  # LD-45
        self.assertIsNone(HOSTNAME_RE.search(self.code), "host name hard-coded: %s" % HOSTNAME_RE.search(self.code))
        self.assertNotRegex(self.code, r"\b\d{1,3}(\.\d{1,3}){3}\b")
        allc = "\n".join(self.files.values())
        self.assertIn("LD-45", allc)
        self.assertRegex(allc, r"CR-C1-002|CR-T09|AC-12\.3")

    def test_seed_by_pg_basebackup_with_slot_over_replicator(self):  # CR-T09 (a)
        self.assertIn("pg_basebackup", self.code)
        self.assertRegex(self.code, r"--slot[ =]|\s-S\s|--create-slot|pg_create_physical_replication_slot")
        self.assertIn("lims_replicator", self.code)
        self.assertIn("dr1", self.code + "\n".join(self.files.values()), "slot name dr1 (TRD s9.5)")
        self.assertRegex(self.code, r"-X\s*stream|--wal-method[ =]stream|-Xs\b", "WAL streamed during the base backup")

    def test_slot_exists_before_streaming_and_creation_is_idempotent(self):  # rerun must not fail on `already exists`
        self.assertRegex(self.code, r"pg_create_physical_replication_slot|--create-slot|-C\b")
        self.assertRegex(self.code, r"pg_replication_slots|--if-not-exists|failed_when|creates:",
                         "slot creation / seeding must be re-runnable")

    def test_seed_is_once_only(self):  # never wipe a running standby
        self.assertRegex(self.code, r"creates:|ansible\.builtin\.stat|PG_VERSION|standby\.signal")
        self.assertIn("standby.signal", self.code, "standby.signal marks recovery mode")
        self.assertNotRegex(self.code, r"(?s)state:\s*absent[^\n]*\n[^\n]*(pgdata|PG_VERSION|/pg/)", "no task deletes PGDATA")

    def test_password_via_tmpfs_passfile_never_on_a_command_line(self):  # 07-SEC, AB-7
        self.assertIn("lims_replicator_password", self.code, "secret id from the schema")
        self.assertRegex(self.code, r"/run/lims/secrets/")
        self.assertRegex(self.code, r"(?s)lims_replicator_password.{0,500}?mode:\s*\"?0?600", "passfile mode 0600")
        self.assertNotRegex(self.code, r"PGPASSWORD\s*=|PGPASSWORD:", "PGPASSWORD shows in /proc/<pid>/environ and logs")
        self.assertNotRegex(self.code, r"password=", "password in a conninfo / command line")
        self.assertIn("no_log: true", self.code)

    def test_no_cipher_pass_and_no_pgbackrest_on_dr(self):  # AC-12.3
        allc = "\n".join(self.files.values()).lower()
        self.assertNotIn("cipher", allc)
        self.assertNotIn("pgbackrest_repo", allc)
        self.assertNotIn("restore_command", self.code)

    def test_standby_conf_is_rendered_from_database_standby_template(self):
        need(STANDBY_J2)
        self.assertIn("standby.conf.j2", self.code)

    def test_lag_metric_script_installed_and_timed(self):  # done_when "lag metric"
        need(SCRIPT)
        self.assertIn("lims-standby-metrics", self.code)
        self.assertRegex(self.code, r"OnCalendar=(minutely|(\*-\*-\*\s+)?\*:(\*|0/1)(:00)?)\s|OnUnitActiveSec=\s*(30s|60s|1min)",
                         "scheduled every minute")
        m = re.search(r"lims-standby-metrics\.sh.{0,300}?mode:\s*\"?(0\d{3})", self.code, re.S)
        self.assertTrue(m, "explicit script mode")
        self.assertNotIn(m.group(1)[-1], "2367", "mode %s world-accessible" % m.group(1))

    def test_replicator_secret_consumer_is_dr_standby_only(self):  # schema: lims_replicator_password consumers
        for env in ("dev", "staging", "prod"):
            d = yaml.safe_load(need(SCHEMAS / ("%s.secrets.schema.yaml" % env)))
            ent = [e for e in d["secrets"] if e["id"] == "lims_replicator_password"]
            self.assertEqual(len(ent), 1)
            self.assertEqual(ent[0]["consumers"], ["dr-1 standby"])


# ---------------------------------------------------------------- lag metric script (fake psql)
def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def _p(path):
    s = Path(path).as_posix()
    if os.name == "nt" and re.match(r"^[A-Za-z]:/", s):
        s = "/" + s[0].lower() + s[2:]
    return s


FAKE_PSQL = """#!/usr/bin/env bash
echo "psql $*" >> "$FIX/calls.log"
[ "${FAKE_PSQL_RC:-0}" = 0 ] || { echo "psql: error: connection to server failed" >&2; exit "$FAKE_PSQL_RC"; }
printf '%s\\n' "$FAKE_PSQL_OUT"
"""


class LagMetricScriptTest(unittest.TestCase):
    def setUp(self):
        self.src = need(SCRIPT)
        self.tmp = Path(tempfile.mkdtemp(prefix="t12m-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin, self.tf = self.tmp / "bin", self.tmp / "textfile"
        self.bin.mkdir()
        self.tf.mkdir()
        (self.bin / "psql").write_bytes(FAKE_PSQL.encode())

    def run_script(self, out="t|0.4", rc=0):
        env = dict(os.environ, FIX=_p(self.tmp), FAKE_PSQL_OUT=out, FAKE_PSQL_RC=str(rc), TEXTFILE_DIR=_p(self.tf),
                   PATH=_p(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        r = subprocess.run([_bash(), _p(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        files = sorted(self.tf.iterdir())
        text = "".join(f.read_text() for f in files if f.suffix == ".prom")
        return r, text, files

    @staticmethod
    def val(text, name):
        m = re.search(r"^%s(?:\{[^}]*\})?\s+(\S+)\s*$" % re.escape(name), text, re.M)
        return float(m.group(1)) if m else None

    def test_standby_in_recovery_reports_lag(self):
        r, t, _ = self.run_script("t|3.2")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.val(t, "lims_ops_standby_up"), 1)
        self.assertEqual(self.val(t, "lims_ops_standby_in_recovery"), 1)
        self.assertAlmostEqual(self.val(t, "lims_ops_standby_replay_lag_seconds"), 3.2, places=3)

    def test_lag_over_60_is_reported_as_is(self):  # StandbyLagHigh is evaluated on this value
        _, t, _ = self.run_script("t|75")
        self.assertEqual(self.val(t, "lims_ops_standby_replay_lag_seconds"), 75)

    def test_unknown_lag_is_absent_never_zero(self):  # fail-safe: no data must not look like 'caught up'
        for out in ("t|", "t"):
            with self.subTest(out=out):
                r, t, _ = self.run_script(out)
                self.assertEqual(self.val(t, "lims_ops_standby_in_recovery"), 1)
                self.assertIsNone(self.val(t, "lims_ops_standby_replay_lag_seconds"), t)

    def test_not_in_recovery_means_promoted_or_broken(self):  # page-worthy: a standby that is no longer one
        _, t, _ = self.run_script("f|")
        self.assertEqual(self.val(t, "lims_ops_standby_up"), 1)
        self.assertEqual(self.val(t, "lims_ops_standby_in_recovery"), 0)
        self.assertIsNone(self.val(t, "lims_ops_standby_replay_lag_seconds"))

    def test_psql_failure_marks_down_and_leaves_no_stale_lag(self):  # link-cut / crashed standby
        self.run_script("t|1.0")
        r, t, _ = self.run_script("", rc=2)
        self.assertEqual(self.val(t, "lims_ops_standby_up"), 0, t)
        self.assertIsNone(self.val(t, "lims_ops_standby_replay_lag_seconds"), "stale lag from the previous run")
        self.assertIsNone(self.val(t, "lims_ops_standby_in_recovery"))

    def test_garbage_output_is_not_turned_into_numbers(self):  # injection / odd psql output
        for out in ("t|abc", "t|1;rm -rf /", "x|5", "t|-3", "t|1 2"):
            with self.subTest(out=out):
                r, t, files = self.run_script(out)
                lag = self.val(t, "lims_ops_standby_replay_lag_seconds")
                self.assertTrue(lag is None or lag >= 0, t)
                if out == "t|-3":
                    self.assertTrue(lag is None or lag == 0, "negative lag clamped or dropped")
                self.assertNotIn("rm -rf", t)

    def test_atomic_write_leaves_a_single_prom_file_and_no_temp(self):  # node_exporter reads *.prom only; half files break scrapes
        _, _, files = self.run_script("t|1")
        self.assertEqual([f.suffix for f in files], [".prom"], [f.name for f in files])
        _, _, files = self.run_script("t|2")
        self.assertEqual([f.suffix for f in files], [".prom"], [f.name for f in files])

    def test_has_help_and_type_lines_for_each_metric(self):
        _, t, _ = self.run_script("t|1")
        for m in ("lims_ops_standby_up", "lims_ops_standby_in_recovery", "lims_ops_standby_replay_lag_seconds"):
            self.assertRegex(t, r"# TYPE %s gauge" % m)

    def test_query_guards_idle_primary_false_lag(self):  # replay timestamp stops advancing on an idle primary -> fake 'lag'
        s = uncommented(self.src)
        for tok in ("pg_is_in_recovery", "pg_last_xact_replay_timestamp", "pg_last_wal_receive_lsn", "pg_last_wal_replay_lsn"):
            self.assertIn(tok, s, "query must use %s (caught-up standby on an idle primary has lag 0)" % tok)

    def test_read_only_no_secrets_no_host_names(self):
        s = uncommented(self.src)
        self.assertIsNone(HOSTNAME_RE.search(s), "LD-45")
        self.assertNotRegex(s, r"PGPASSWORD|password=")
        self.assertNotRegex(s, r"(?i)\b(insert|update|delete|drop|alter|pg_promote|pg_wal_replay_resume)\b", "metrics script must be read-only")

    def test_script_calls_psql_without_prompting_for_a_password(self):  # cron/systemd has no tty
        self.run_script("t|1")
        calls = (self.tmp / "calls.log").read_text()
        self.assertRegex(calls, r"(?:^|\s)(-w\b|--no-password)", "psql -w: never hang on a password prompt")


if __name__ == "__main__":
    unittest.main()
