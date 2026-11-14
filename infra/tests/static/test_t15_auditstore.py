"""T-15 tests (tester role): audit store (append-only), logical replication, nightly digest chain, drift job, lag metric.

Covers AC-18.2 (row on primary -> store < 60 s, `lims_ops_auditstore_lag_seconds`), AC-18.3 (writer INSERT only; nobody who is
a person/job has UPDATE/DELETE/TRUNCATE), 02-TRD s10.3, 05-SCHEMA s3.1-3.5, 08 A29.2 / A28.5 (`audit_log.detail`, nullable
`actor_id`/`created_by`), 07-SEC (AB-8 digest re-verify), 06-PLAN row T-15. LD-45: both profiles; no host names in role/scripts.

NOT provable here (no PostgreSQL binaries on this machine): a live primary -> store replication, publisher-delete-not-propagated,
digest SQL execution, spike result. Those live in infra/tests/integration/test_t15_live.py (LIMS_T15_LIVE=1, PG17 on PATH).
Here: committed artefacts, the pure-python drift tool, the lag script with a faked `psql`.

CONTRACTS where the spec is silent (writer meets them; ambiguity -> dispute, not a silent change):
 * infra/auditstore/schema.sql = 05-SCHEMA s3.4 verbatim in substance, DB-agnostic (no CREATE DATABASE / \\connect). Role names
   as in s3.2. Replicated tables: no FK, no CHECK, no RLS; PK kept.
 * infra/auditstore/drift.py (stdlib python 3): `python drift.py SOURCE.json SUBSCRIBER.json [--apply-sql]`.
   Inputs = JSON list of information_schema.columns rows {table_schema, table_name, column_name, data_type, udt_name?, is_nullable
   'YES'|'NO'}. Exit 0 = identical (names, types, nullability; order ignored). Exit 1 = drift; stdout has one line per difference
   containing `schema.table.column` and one of the words missing|extra|type|nullability. Exit 2 = unreadable/invalid input or an
   EMPTY source (comparing nothing must never pass). `--apply-sql` prints SQL for what gen-schema.sh --apply may fix: ADD COLUMN
   for a missing column (never NOT NULL) and `DROP NOT NULL` where the subscriber has NOT NULL and the source does not. It NEVER
   prints SET NOT NULL, DROP COLUMN, or a type change; if any non-fixable difference remains the exit code is still 1.
 * infra/auditstore/digest.sql: nightly, run as `audit_digest` (SELECT on tables, SELECT+INSERT on daily_digests - no UPDATE).
 * infra/auditstore/DECISION.md: headings containing `Subscription owner` and `RLS`; names audit_writer, lims_audit_ship,
   run_as_owner, pg_create_subscription; ends in a verdict word CONFIRMED or FALLBACK (FALLBACK => cites .orchestra/cr/).
 * infra/tests/internal/auditstore_roles.sql (writer deliverable, run with psql -v ON_ERROR_STOP=1): RAISE EXCEPTION on failure.
 * Role infra/ansible/roles/auditstore, own play in site.yml (after pgbackrest). defaults: `auditstore_enabled`, `auditstore_db_name`
   ('auditstore' in full, 'lims_audit' in lean/dev - LD-45 same cluster), `auditstore_port` (5433 full, 5432 otherwise),
   `auditstore_host_group` ('dr' in full, 'data' otherwise). Fail closed: missing topology_profile => not enabled and tasks assert it.
   In lean the publisher and subscriber share a cluster: the subscription SQL must use create_slot = false with the slot pre-created
   (CREATE SUBSCRIPTION to the own cluster with create_slot=true hangs) - the role template must contain both.
 * files/lims-auditstore-metrics.sh (bash): env TEXTFILE_DIR; `psql -w ... -A -t -F'|'` ONE row `sub_enabled|lag_seconds`
   (t/f | number or empty when unknown). Writes $TEXTFILE_DIR/*.prom: lims_ops_auditstore_up, lims_ops_auditstore_subscription_enabled,
   lims_ops_auditstore_lag_seconds (only when known; never 0 for unknown; no stale line after a failed psql). Atomic, read-only.
 * templates for a digest service+timer: OnCalendar 02:30 with Asia/Kathmandu.
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t15_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
AS = ROOT / "infra" / "auditstore"
SCHEMA = AS / "schema.sql"
DIGEST = AS / "digest.sql"
DRIFT = AS / "drift.py"
GEN = AS / "gen-schema.sh"
DECISION = AS / "DECISION.md"
ROLES_SQL = ROOT / "infra" / "tests" / "internal" / "auditstore_roles.sql"
ROLE = ROOT / "infra" / "ansible" / "roles" / "auditstore"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
METRICS = ROLE / "files" / "lims-auditstore-metrics.sh"
HOSTNAME_RE = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")
TABLES = ("audit.audit_log", "audit.access_log", "billing.activity_log")
PEOPLE = ("audit_writer", "audit_digest", "audit_reader", "lims_monitor")

PROFILES = {  # LD-45
    "full": {"groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]}},
    "lean": {"groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": [], "backup": ["backup-1"]}},
    "dev": {"groups": {"data": ["dev-1"], "app": ["dev-1"], "ops": ["dev-1"], "dr": []}},
}


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


ENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def sql_only(text):
    """SQL without -- comments (the spec DDL has trailing explanatory comments and a commented-out CREATE SUBSCRIPTION)."""
    return "\n".join(re.sub(r"--.*$", "", l) for l in text.splitlines())


def role_files():
    if not ROLE.is_dir():
        raise AssertionError("missing dir infra/ansible/roles/auditstore")
    files = {p.relative_to(ROLE).as_posix(): p.read_text(encoding="utf-8") for p in sorted(ROLE.rglob("*")) if p.is_file()}
    if not files:
        raise AssertionError("roles/auditstore is empty")
    return files


def create_table_body(sql, qname):
    m = re.search(r"CREATE\s+TABLE\s+%s\s*\((.*?)\n\)\s*;" % re.escape(qname), sql, re.S | re.I)
    if not m:
        raise AssertionError("no CREATE TABLE %s in schema.sql" % qname)
    return m.group(1)


def column_defs(body):
    """name -> definition text, splitting on top-level commas (ignores commas inside parentheses)."""
    parts, depth, cur = [], 0, ""
    for ch in body:
        depth += ch == "("
        depth -= ch == ")"
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    out = {}
    for p in parts:
        p = p.strip()
        if not p or re.match(r"(?i)(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b", p):
            continue
        name, _, rest = p.partition(" ")
        out[name] = " ".join(rest.split())
    return out


# ------------------------------------------------------------------ schema.sql (05-SCHEMA s3.4)
class SchemaTest(unittest.TestCase):
    def setUp(self):
        self.raw = need(SCHEMA)
        self.sql = sql_only(self.raw)

    def test_roles_and_schemas_per_s32(self):
        for r in ("auditstore_owner", "audit_writer", "audit_digest", "audit_reader", "lims_monitor"):
            self.assertRegex(self.sql, r"CREATE\s+ROLE\s+%s\b" % r)
        self.assertRegex(self.sql, r"CREATE\s+ROLE\s+auditstore_owner\s+NOLOGIN")
        self.assertRegex(self.sql, r"GRANT\s+pg_monitor\s+TO\s+lims_monitor")
        for s in ("audit", "billing", "auditstore", "auditstore_meta"):
            self.assertRegex(self.sql, r"CREATE\s+SCHEMA\s+%s\s+AUTHORIZATION\s+auditstore_owner" % s)
        self.assertRegex(self.sql, r"REVOKE\s+CREATE\s+ON\s+SCHEMA\s+public\s+FROM\s+PUBLIC")

    def test_no_literal_passwords(self):  # psql variables only
        for m in re.finditer(r"PASSWORD\s+(\S+)", self.sql, re.I):
            self.assertRegex(m.group(1), r"^:'[a-z_]+_pw'", "literal password in schema.sql: %s" % m.group(1))

    def test_database_agnostic_for_lean_and_full(self):  # LD-45: db name is lims_audit (lean) or auditstore (full)
        self.assertNotRegex(self.sql, r"(?i)CREATE\s+DATABASE|\\connect|\\c\s")

    def test_replicated_tables_have_the_same_columns_as_the_primary(self):
        a = column_defs(create_table_body(self.sql, "audit.audit_log"))
        want = ["id", "tenant_id", "centre_id", "schema_name", "table_name", "row_id", "action", "changed_columns", "old_values",
                "new_values", "actor_id", "actor_type", "membership_id", "support_session_id", "request_id", "client_ip",
                "user_agent", "detail", "occurred_at", "created_at", "created_by"]
        self.assertEqual(list(a), want)
        # 08 A29.2 / A28.5
        self.assertRegex(a["detail"], r"(?i)^jsonb$", "detail jsonb, nullable")
        self.assertNotRegex(a["actor_id"], r"(?i)NOT\s+NULL", "actor_id nullable (maintenance DEFINER rows)")
        self.assertNotRegex(a["created_by"], r"(?i)NOT\s+NULL", "created_by nullable (A28.5)")
        for c in ("id", "tenant_id", "actor_type", "occurred_at", "created_at", "action"):
            self.assertRegex(a[c], r"(?i)NOT\s+NULL", c)
        x = column_defs(create_table_body(self.sql, "audit.access_log"))
        self.assertEqual(list(x), ["id", "tenant_id", "centre_id", "actor_id", "actor_type", "membership_id", "support_session_id",
                                   "action", "entity_type", "entity_id", "purpose_code", "outcome", "detail", "request_id",
                                   "client_ip", "user_agent", "occurred_at", "created_at", "created_by"])
        self.assertRegex(x["actor_id"], r"(?i)NOT\s+NULL")
        self.assertRegex(x["created_by"], r"(?i)NOT\s+NULL")
        b = column_defs(create_table_body(self.sql, "billing.activity_log"))
        self.assertEqual(list(b), ["id", "tenant_id", "centre_id", "action", "document_kind", "document_id", "document_no",
                                   "actor_id", "actor_membership_id", "actor_type", "occurred_at", "request_id", "details",
                                   "is_active", "created_at", "created_by"])

    def test_primary_keys_kept_for_idempotent_apply(self):
        for t, pk in (("audit.audit_log", r"\(tenant_id,\s*occurred_at,\s*id\)"), ("audit.access_log", r"\(tenant_id,\s*occurred_at,\s*id\)"),
                      ("billing.activity_log", r"\(id\)")):
            self.assertRegex(create_table_body(self.sql, t), r"(?i)PRIMARY\s+KEY\s*" + pk, t)

    def test_no_fk_check_or_rls_on_replicated_tables(self):  # a relaxed CHECK on the primary must never block apply
        for t in TABLES:
            body = create_table_body(self.sql, t)
            self.assertNotRegex(body, r"(?i)\bREFERENCES\b|FOREIGN\s+KEY|\bCHECK\b", t)
        self.assertNotRegex(self.sql, r"(?i)ROW\s+LEVEL\s+SECURITY|CREATE\s+POLICY")

    def test_investigation_indexes_exist(self):
        for ix in ("audit_log__tenant_id_table_row__idx", "audit_log__tenant_id_actor__idx", "access_log__tenant_id_entity__idx",
                   "access_log__tenant_id_actor__idx", "activity_log__tenant_id_occurred__idx",
                   "activity_log__tenant_id_actor_occurred__idx"):
            self.assertIn(ix, self.sql)

    def test_daily_digests_table_shape(self):
        body = create_table_body(self.sql, "auditstore_meta.daily_digests")
        cols = column_defs(body)
        self.assertEqual(list(cols), ["tenant_id", "source_table", "business_date", "row_count", "rows_sha256", "prev_digest",
                                      "chain_digest", "computed_at"])
        self.assertRegex(body, r"(?i)PRIMARY\s+KEY\s*\(\s*tenant_id,\s*source_table,\s*business_date\s*\)")
        self.assertRegex(body, r"octet_length\(chain_digest\)\s*=\s*32")
        self.assertRegex(body, r"octet_length\(rows_sha256\)\s*=\s*32")
        for t in ("auditstore_meta.ops_audit", "auditstore_meta.schema_sync_log"):
            create_table_body(self.sql, t)

    def test_reader_views(self):
        for v in ("audit_log", "access_log", "billing_activity_log", "daily_digests"):
            self.assertRegex(self.sql, r"CREATE\s+VIEW\s+auditstore\.%s\b" % v)

    def test_grants_are_append_only(self):  # AC-18.3
        grants = re.findall(r"GRANT\s+(.*?)\s+ON\s+(.*?)\s+TO\s+([^;]+);", self.sql, re.S | re.I)
        self.assertTrue(grants)
        for privs, on, to in grants:
            p = privs.upper()
            self.assertNotRegex(p, r"\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|\bALL\b", "GRANT %s ON %s" % (privs, on))
            self.assertNotRegex(to.upper(), r"\bPUBLIC\b", "no grant to PUBLIC")
            if "INSERT" in p and re.search(r"audit\.|billing\.", on):
                self.assertEqual(to.strip(), "audit_writer", "only audit_writer inserts into replicated tables")
        ins = [g for g in grants if "INSERT" in g[0].upper() and "audit_log" in g[1]]
        self.assertEqual(len(ins), 1)
        for t in TABLES:
            self.assertIn(t, ins[0][1])
        self.assertRegex(self.sql, r"REVOKE\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+audit,\s*billing,\s*auditstore_meta\s+FROM\s+PUBLIC")
        self.assertNotRegex(self.sql, r"(?i)ALTER\s+DEFAULT\s+PRIVILEGES", "default privileges would hand UPDATE/DELETE to new tables")

    def test_digest_and_reader_privilege_split(self):
        self.assertRegex(self.sql, r"GRANT\s+SELECT\s+ON\s+audit\.audit_log,\s*audit\.access_log,\s*billing\.activity_log\s+TO\s+audit_digest")
        self.assertRegex(self.sql, r"GRANT\s+SELECT,\s*INSERT\s+ON\s+auditstore_meta\.daily_digests,\s*auditstore_meta\.ops_audit\s+TO\s+audit_digest")
        self.assertRegex(self.sql, r"GRANT\s+USAGE\s+ON\s+SCHEMA\s+auditstore\s+TO\s+audit_reader")
        self.assertNotRegex(self.sql, r"(?i)GRANT\s+USAGE\s+ON\s+SCHEMA\s+[^;]*\b(audit|billing|auditstore_meta)\b[^;]*TO[^;]*audit_reader")

    def test_nobody_who_is_a_person_or_job_is_member_of_the_owner(self):  # SET ROLE auditstore_owner = UPDATE/DELETE
        for r in ("audit_digest", "audit_reader", "lims_monitor"):
            self.assertNotRegex(self.sql, r"(?i)GRANT\s+auditstore_owner\s+TO\s+[^;]*\b%s\b" % r)
            self.assertNotRegex(self.sql, r"(?i)ALTER\s+ROLE\s+%s\s+SUPERUSER" % r)


# ------------------------------------------------------------------ drift.py (08 A29.2)
def col(table, name, typ="text", nullable="YES", schema="audit", udt=None):
    d = {"table_schema": schema, "table_name": table, "column_name": name, "data_type": typ, "is_nullable": nullable}
    if udt:
        d["udt_name"] = udt
    return d


def baseline():
    return [col("audit_log", "id", "uuid", "NO"), col("audit_log", "actor_id", "uuid", "YES"),
            col("audit_log", "created_by", "uuid", "YES"), col("audit_log", "detail", "jsonb", "YES"),
            col("audit_log", "occurred_at", "timestamp with time zone", "NO"),
            col("audit_log", "changed_columns", "ARRAY", "NO", udt="_text"),
            col("access_log", "id", "uuid", "NO"), col("activity_log", "id", "uuid", "NO", schema="billing")]


class DriftTool(unittest.TestCase):
    def setUp(self):
        need(DRIFT)
        self.tmp = Path(tempfile.mkdtemp(prefix="t15d-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def run_drift(self, src, sub, *flags, raw=None):
        a, b = self.tmp / "src.json", self.tmp / "sub.json"
        a.write_text(raw[0] if raw else json.dumps(src))
        b.write_text(raw[1] if raw else json.dumps(sub))
        r = subprocess.run([sys.executable, "-I", str(DRIFT), str(a), str(b), *flags], capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def test_identical_passes_regardless_of_row_order(self):
        rc, out = self.run_drift(baseline(), list(reversed(baseline())))
        self.assertEqual(rc, 0, out)

    def test_missing_column_name_fails(self):  # 08 A29.2: audit_log.detail added on the primary first
        rc, out = self.run_drift(baseline(), [c for c in baseline() if c["column_name"] != "detail"])
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"audit\.audit_log\.detail")
        self.assertRegex(out, r"(?i)missing")

    def test_renamed_column_fails_both_ways(self):
        sub = [dict(c, column_name="details") if c["column_name"] == "detail" else c for c in baseline()]
        rc, out = self.run_drift(baseline(), sub)
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"audit\.audit_log\.detail\b.*(?i:missing)|(?i:missing).*audit\.audit_log\.detail\b", "source column absent in store")
        self.assertRegex(out, r"audit\.audit_log\.details")
        self.assertRegex(out, r"(?i)extra")

    def test_type_mismatch_fails(self):
        sub = [dict(c, data_type="json") if c["column_name"] == "detail" else c for c in baseline()]
        rc, out = self.run_drift(baseline(), sub)
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"audit\.audit_log\.detail")
        self.assertRegex(out, r"(?i)type")

    def test_udt_mismatch_fails_for_arrays(self):  # text[] vs int[] share data_type ARRAY
        sub = [dict(c, udt_name="_int4") if c["column_name"] == "changed_columns" else c for c in baseline()]
        rc, out = self.run_drift(baseline(), sub)
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"changed_columns")

    def test_nullability_mismatch_fails_in_both_directions(self):  # actor_id / created_by nullable (A28.5)
        for name in ("actor_id", "created_by"):
            for src_null, sub_null in (("YES", "NO"), ("NO", "YES")):
                with self.subTest(col=name, src=src_null, sub=sub_null):
                    src = [dict(c, is_nullable=src_null) if c["column_name"] == name else c for c in baseline()]
                    sub = [dict(c, is_nullable=sub_null) if c["column_name"] == name else c for c in baseline()]
                    rc, out = self.run_drift(src, sub)
                    self.assertEqual(rc, 1, out)
                    self.assertRegex(out, r"audit\.audit_log\.%s" % name)
                    self.assertRegex(out, r"(?i)nullab")

    def test_whole_table_missing_in_store_fails(self):
        rc, out = self.run_drift(baseline(), [c for c in baseline() if c["table_name"] != "activity_log"])
        self.assertEqual(rc, 1, out)
        self.assertRegex(out, r"billing\.activity_log\.id")

    def test_schema_qualified_names_are_not_confused(self):  # same table name in another schema is a different table
        sub = [dict(c, table_schema="public") if c["table_name"] == "activity_log" else c for c in baseline()]
        rc, out = self.run_drift(baseline(), sub)
        self.assertEqual(rc, 1, out)

    def test_bad_input_fails_closed_never_zero(self):
        self.assertEqual(self.run_drift(None, None, raw=("not json", "[]"))[0], 2)
        self.assertEqual(self.run_drift(None, None, raw=("[]", "[]"))[0], 2, "empty source = nothing compared = must not pass")
        self.assertEqual(self.run_drift(None, None, raw=('{"a":1}', "[]"))[0], 2)
        self.assertEqual(self.run_drift(None, None, raw=('[{"column_name":"x"}]', '[{"column_name":"x"}]'))[0], 2, "rows missing keys")
        rc = subprocess.run([sys.executable, "-I", str(DRIFT), str(self.tmp / "nope.json"), str(self.tmp / "nope2.json")],
                            capture_output=True, text=True, timeout=60).returncode
        self.assertEqual(rc, 2)

    def test_apply_sql_adds_missing_column_nullable_and_drops_not_null_only(self):
        src = baseline()
        sub = [c for c in baseline() if c["column_name"] != "detail"]
        sub = [dict(c, is_nullable="NO") if c["column_name"] == "actor_id" else c for c in sub]
        rc, out = self.run_drift(src, sub, "--apply-sql")
        self.assertEqual(rc, 0, out)
        self.assertRegex(out, r"(?is)ALTER\s+TABLE\s+[\"]?audit[\"]?\.[\"]?audit_log[\"]?\s+ADD\s+COLUMN\s+[\"]?detail[\"]?\s+jsonb\b")
        self.assertRegex(out, r"(?is)ALTER\s+TABLE\s+[\"]?audit[\"]?\.[\"]?audit_log[\"]?\s+ALTER\s+COLUMN\s+[\"]?actor_id[\"]?\s+DROP\s+NOT\s+NULL")
        self.assertNotRegex(out, r"(?i)SET\s+NOT\s+NULL|DROP\s+COLUMN|\bTYPE\b|DELETE|UPDATE|TRUNCATE")
        add = re.search(r"(?is)ADD\s+COLUMN\s+[\"]?detail[\"]?[^;]*;", out).group(0)
        self.assertNotRegex(add, r"(?i)NOT\s+NULL", "an added column is never NOT NULL (existing rows)")

    def test_apply_sql_never_adds_not_null(self):  # source stricter than store: report, do not fix, exit 1
        src = [dict(c, is_nullable="NO") if c["column_name"] == "actor_id" else c for c in baseline()]
        rc, out = self.run_drift(src, baseline(), "--apply-sql")
        self.assertEqual(rc, 1, out)
        self.assertNotRegex(out, r"(?i)SET\s+NOT\s+NULL")

    def test_apply_sql_refuses_type_change_and_extra_column(self):
        sub = [dict(c, data_type="json") if c["column_name"] == "detail" else c for c in baseline()]
        sub.append(col("audit_log", "legacy", "text"))
        rc, out = self.run_drift(baseline(), sub, "--apply-sql")
        self.assertEqual(rc, 1, out)
        self.assertNotRegex(out, r"(?i)ALTER\s+COLUMN\s+[\"]?detail[\"]?\s+(SET\s+DATA\s+)?TYPE|DROP\s+COLUMN\s+[\"]?legacy")

    def test_sql_output_cannot_be_injected_through_names(self):
        evil = [col("audit_log", 'x"; DROP TABLE audit.audit_log; --', "text")]
        rc, out = self.run_drift(baseline() + evil, baseline(), "--apply-sql")
        if rc != 2:  # refusing is fine; otherwise, in every SQL line the name is only inside a quoted identifier
            sql_lines = [l for l in out.splitlines() if l.lstrip().upper().startswith("ALTER")]
            self.assertTrue(sql_lines, out)
            for l in sql_lines:
                outside = re.sub(r'"(?:[^"]|"")*"', '""', l)
                self.assertNotIn("DROP TABLE", outside.upper(), l)


class GenSchema(unittest.TestCase):
    def test_syntax_and_contract(self):
        src = need(GEN)
        bash = next((c for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")) if c and Path(c).exists()), None)
        self.assertTrue(bash, "bash not found")
        self.assertEqual(subprocess.run([bash, "-n", str(GEN)], capture_output=True, timeout=60).returncode, 0)
        self.assertRegex(src, r"--apply")
        self.assertIn("drift.py", src, "gen-schema.sh --apply must use the same drift logic as the CI job")
        self.assertRegex(src, r"set -[a-z]*e[a-z]*u|set -o errexit", "fail fast")
        self.assertRegex(src, r"pg_dump[^\n]*--schema-only", "generated from a migrated staging DB")
        self.assertNotRegex(sql_only(src), r"(?i)\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b")
        self.assertNotRegex(src, r"(?i)PGPASSWORD\s*=\s*\S+|password=\S")


# ------------------------------------------------------------------ digest.sql (REQ-SEC-097)
class DigestSql(unittest.TestCase):
    def setUp(self):
        self.sql = sql_only(need(DIGEST))

    def test_formula_matches_spec(self):
        s = self.sql
        self.assertRegex(s, r"(?i)sha256\(")
        self.assertRegex(s, r"(?is)string_agg\([^;]*?ORDER\s+BY\s+occurred_at,\s*id\)")
        self.assertIn("E'\\n'", s)
        self.assertRegex(s, r"(?i)convert_to\([^)]*'UTF8'\)")
        self.assertRegex(s, r"(?i)coalesce\(\s*prev_digest\s*,\s*'\\x'::bytea\)")
        self.assertRegex(s, r"(?i)convert_to\(\s*row_count::text\s*,\s*'UTF8'\s*\)", "chain includes the row count as text")
        self.assertNotRegex(s, r"(?i)prev_digest\s*\|\|\s*rows_sha256\s*\|\|\s*row_count", "bytea || text does not resolve")

    def test_business_date_is_npt_and_covers_all_three_tables(self):
        self.assertIn("Asia/Kathmandu", self.sql)
        for t in TABLES:
            self.assertIn(t, self.sql)
        self.assertIn("daily_digests", self.sql)

    def test_reverifies_seven_days_and_counts_mismatch(self):
        self.assertRegex(self.sql, r"(?i)\b7\b.*day|interval\s+'7\s+days?'|- *7\b")
        self.assertRegex(self.sql, r"(?i)mismatch")

    def test_append_only_for_audit_digest_role(self):  # audit_digest has SELECT+INSERT: UPDATE/DELETE would fail at run time
        self.assertNotRegex(self.sql, r"(?i)\bUPDATE\b|\bDELETE\b|\bTRUNCATE\b|DO\s+UPDATE|DROP\s+TABLE")
        self.assertRegex(self.sql, r"(?i)INSERT\s+INTO\s+auditstore_meta\.daily_digests")
        self.assertRegex(self.sql, r"(?i)ON\s+CONFLICT[^;]*DO\s+NOTHING|WHERE\s+NOT\s+EXISTS", "re-run the same day must not fail or rewrite")

    def test_mismatch_is_never_silently_recomputed(self):  # 05-SCHEMA s3.4: backfill recorded in ops_audit first
        self.assertIn("ops_audit", self.sql)

    def test_chain_formula_reference_model(self):
        """The spec formula, computed independently here: first day chains from the empty bytea; a changed row changes every later link."""
        import hashlib

        def day(rows, prev):
            rs = hashlib.sha256("\n".join(rows).encode()).digest()
            return rs, hashlib.sha256((prev or b"") + rs + str(len(rows)).encode()).digest()

        _, c1 = day(["a", "b"], None)
        _, c2 = day(["c"], c1)
        _, c1x = day(["a", "B"], None)
        _, c2x = day(["c"], c1x)
        self.assertNotEqual(c1, c1x)
        self.assertNotEqual(c2, c2x)
        self.assertEqual(len(c2), 32)


# ------------------------------------------------------------------ auditstore_roles.sql (05-SCHEMA s3.5)
class RoleAssertionsSql(unittest.TestCase):
    def setUp(self):
        self.sql = sql_only(need(ROLES_SQL))

    def test_every_person_role_table_privilege_is_denied(self):  # AC-18.3
        for r in PEOPLE[:3]:
            self.assertIn("'%s'" % r, self.sql)
        for t in TABLES:
            self.assertIn(t, self.sql)
        for p in ("UPDATE", "DELETE", "TRUNCATE"):
            self.assertIn("'%s'" % p, self.sql)
        self.assertRegex(self.sql, r"(?i)has_table_privilege")

    def test_covers_all_roles_in_the_matrix(self):  # a loop over a role list is fine; a missing role is not
        for r in ("audit_writer", "audit_digest", "audit_reader"):
            self.assertIn(r, self.sql)

    def test_writer_has_insert_and_reader_has_no_schema_access(self):
        self.assertRegex(self.sql, r"(?is)has_table_privilege\(\s*'audit_writer'[^)]*'INSERT'|'INSERT'")
        self.assertRegex(self.sql, r"(?i)has_schema_privilege")
        for s in ("audit", "billing", "auditstore_meta"):
            self.assertIn("'%s'" % s, self.sql)

    def test_digest_role_cannot_rewrite_digests(self):
        self.assertIn("daily_digests", self.sql)

    def test_failures_are_loud(self):
        self.assertRegex(self.sql, r"(?i)RAISE\s+EXCEPTION")

    def test_column_comparison_fixture_a29_2(self):  # 05-SCHEMA s3.5 third bullet
        self.assertIn("information_schema.columns", self.sql)
        for tok in ("detail", "actor_id", "created_by", "is_nullable"):
            self.assertIn(tok, self.sql)

    def test_no_membership_path_to_the_owner(self):
        self.assertRegex(self.sql, r"(?i)pg_has_role|pg_auth_members")
        self.assertIn("auditstore_owner", self.sql)

    def test_no_data_modification_in_the_assertions(self):
        self.assertNotRegex(self.sql, r"(?i)\b(INSERT\s+INTO|DELETE\s+FROM|DROP\s+|TRUNCATE\s+TABLE|ALTER\s+ROLE|GRANT\s)")


# ------------------------------------------------------------------ DECISION.md (spike outcome)
class DecisionDoc(unittest.TestCase):
    def setUp(self):
        self.t = need(DECISION)

    def test_records_owner_and_rls_outcome(self):
        self.assertRegex(self.t, r"(?im)^#+ .*Subscription owner")
        self.assertRegex(self.t, r"(?im)^#+ .*\bRLS\b")
        for tok in ("audit_writer", "lims_audit_ship", "run_as_owner", "pg_create_subscription", "FORCE"):
            self.assertIn(tok, self.t)
        self.assertRegex(self.t, r"\b(CONFIRMED|FALLBACK)\b")
        if re.search(r"\bFALLBACK\b", self.t) and not re.search(r"\bCONFIRMED\b", self.t):
            self.assertIn(".orchestra/cr/", self.t, "fallback = a CR to C0-0B must be named")

    def test_lean_profile_and_decisions_cited(self):
        self.assertIn("LD-45", self.t)
        self.assertIn("lims_audit", self.t)
        self.assertRegex(self.t, r"(?i)create_slot\s*=\s*false")


# ------------------------------------------------------------------ role + site.yml
class RoleStatic(unittest.TestCase):
    def setUp(self):
        self.files = role_files()
        self.code = "\n".join(self.files.values())

    def _defaults(self, profile, **extra):
        d = yaml.safe_load(self.files.get("defaults/main.yml") or need(ROLE / "defaults" / "main.yml"))
        c = {"groups": PROFILES[profile]["groups"], "hostvars": {}, "topology_profile": profile}
        c.update(extra)
        out = {}
        for k, v in d.items():
            r = ENV.from_string(v).render(**c) if isinstance(v, str) else v
            out[k] = r.strip() if isinstance(r, str) else r
        return out

    def test_yaml_parses(self):
        for name, text in self.files.items():
            if name.endswith((".yml", ".yaml")):
                yaml.safe_load(text)

    def test_profile_driven_defaults(self):  # LD-45
        f = self._defaults("full")
        self.assertEqual((f["auditstore_db_name"], str(f["auditstore_port"]), f["auditstore_host_group"]), ("auditstore", "5433", "dr"))
        self.assertEqual(str(f["auditstore_enabled"]).lower(), "true")
        for p in ("lean", "dev"):
            d = self._defaults(p)
            self.assertEqual((d["auditstore_db_name"], str(d["auditstore_port"]), d["auditstore_host_group"]), ("lims_audit", "5432", "data"), p)
        self.assertEqual(str(self._defaults("lean")["auditstore_enabled"]).lower(), "true", "lean still has an audit store (separate DB)")

    def test_missing_topology_profile_fails_closed(self):
        d = yaml.safe_load(need(ROLE / "defaults" / "main.yml"))
        out = ENV.from_string(d["auditstore_enabled"]).render(groups=PROFILES["full"]["groups"], hostvars={}) if isinstance(d["auditstore_enabled"], str) else d["auditstore_enabled"]
        self.assertNotEqual(str(out).strip().lower(), "true", "no topology_profile => not enabled (LD-45)")
        t = need(ROLE / "tasks" / "main.yml")
        self.assertRegex(t, r"topology_profile")
        self.assertRegex(t, r"ansible\.builtin\.assert|\bassert:")

    def test_work_is_gated_and_runs_only_on_the_audit_host(self):
        tasks = yaml.safe_load(need(ROLE / "tasks" / "main.yml"))
        self.assertTrue(tasks)
        gated = lambda t: "auditstore_enabled" in str(t.get("when", "")) or "auditstore_host_group" in str(t.get("when", ""))
        self.assertTrue(any("end_host" in str(t) and gated(t) for t in tasks) or all(
            gated(t) or "set_fact" in str(t) or "assert" in str(t) for t in tasks), "tasks not gated on the audit host / enabled")

    def test_no_literal_hosts_ips_or_secrets_and_cites_decisions(self):
        self.assertIsNone(HOSTNAME_RE.search(self.code), HOSTNAME_RE.search(self.code))
        # LD-63: 127.0.0.1 is the loopback psql.j2 must force (not an LD-45 host address); every other IPv4 literal still fails
        self.assertNotRegex(re.sub(r"(?<![\d.])127\.0\.0\.1(?![\d.])", "", self.code), r"\b\d{1,3}(\.\d{1,3}){3}\b")
        self.assertIn("LD-45", self.code)
        self.assertRegex(self.code, r"CR-C1-002|AC-18")
        self.assertNotRegex(self.code, r"(?i)password\s*[:=]\s*['\"]?[A-Za-z0-9]{6,}")

    def test_secret_tasks_hide_values(self):
        for name, text in self.files.items():
            if name.startswith("tasks/"):
                for t in yaml.safe_load(text) or []:
                    blob = yaml.safe_dump(t)
                    if re.search(r"(?i)_pw\b|password|CREATE\s+SUBSCRIPTION|\\set\b", blob):
                        self.assertTrue(t.get("no_log"), "task handling a password lacks no_log: %s" % t.get("name"))

    def test_subscription_sql_is_lean_safe(self):  # same cluster => create_slot=true would hang; insert-only publication
        sub = [t for n, t in self.files.items() if re.search(r"(?i)CREATE\s+SUBSCRIPTION", t)]
        self.assertTrue(sub, "no CREATE SUBSCRIPTION in the role")
        s = "\n".join(sub)
        self.assertRegex(s, r"copy_data\s*=\s*false")
        self.assertRegex(s, r"streaming\s*=\s*on")
        self.assertRegex(s, r"(?i)slot_name\s*=\s*'audit_ship'")
        self.assertRegex(s, r"(?i)PUBLICATION\s+lims_audit_ship")
        self.assertRegex(s, r"create_slot\s*=\s*false")
        self.assertRegex(s, r"pg_create_logical_replication_slot\(\s*'audit_ship'\s*,\s*'pgoutput'")
        self.assertNotRegex(s, r"(?i)password=['\"]?[A-Za-z0-9]{4,}", "password must come from the secret, not a literal")
        self.assertRegex(s, r"(?i)user=lims_audit_ship")

    def test_job_psql_wrapper_forces_tcp_loopback(self):  # review T-15 item 1: unix socket => peer map has no job roles
        w = [t for n, t in self.files.items() if n.endswith("psql.j2")]
        self.assertTrue(w, "psql.j2 wrapper template")
        self.assertRegex(w[0], r"-e\s+PGHOST=127\.0\.0\.1(?!\d)", "job psql must connect over TCP loopback (scram), not the socket")
        self.assertRegex(w[0], r"-e\s+PGPASSWORD(?![A-Za-z_])")

    def test_digest_timer_runs_0230_npt(self):
        timers = [t for n, t in self.files.items() if n.endswith(".timer.j2") and "digest" in n]
        self.assertTrue(timers, "digest timer template")
        self.assertRegex(timers[0], r"OnCalendar=.*02:30(:00)?\s+Asia/Kathmandu")
        svc = [t for n, t in self.files.items() if n.endswith(".service.j2") and "digest" in n]
        self.assertTrue(svc)
        self.assertIn("digest.sql", svc[0] + self.code)
        self.assertRegex(svc[0], r"audit_digest", "digest runs as audit_digest, never the superuser")

    def test_lag_metric_script_installed_and_polled(self):
        self.assertTrue(METRICS.is_file(), "files/lims-auditstore-metrics.sh")
        self.assertRegex(self.code, r"(?i)lims-auditstore-metrics")

    def test_site_yml_play_after_pgbackrest(self):
        plays = yaml.safe_load(need(SITE))
        name = lambda r: r if isinstance(r, str) else r.get("role")
        hit = [i for i, p in enumerate(plays) if "auditstore" in [name(r) for r in p.get("roles", [])]]
        self.assertEqual(len(hit), 1, "exactly one play applies role auditstore")
        self.assertTrue(plays[hit[0]].get("become"))
        pg = [i for i, p in enumerate(plays) if "pgbackrest" in [name(r) for r in p.get("roles", [])]]
        self.assertTrue(pg and hit[0] > pg[0], "after pgBackRest (T-09)")
        hosts = str(plays[hit[0]]["hosts"])
        self.assertTrue({"dr", "data"} <= set(re.split(r"[:,]", hosts.replace(" ", ""))) or "auditstore" in hosts,
                        "play must reach the full-profile dr host and the lean data host; the role gates on auditstore_host_group")


# ------------------------------------------------------------------ lag metric script
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


class LagMetricScript(unittest.TestCase):
    def setUp(self):
        self.src = need(METRICS)
        self.tmp = Path(tempfile.mkdtemp(prefix="t15m-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin, self.tf = self.tmp / "bin", self.tmp / "textfile"
        self.bin.mkdir()
        self.tf.mkdir()
        (self.bin / "psql").write_bytes(FAKE_PSQL.encode())

    def run_script(self, out="t|2.5", rc=0):
        env = dict(os.environ, FIX=_p(self.tmp), FAKE_PSQL_OUT=out, FAKE_PSQL_RC=str(rc), TEXTFILE_DIR=_p(self.tf),
                   PATH=_p(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        r = subprocess.run([_bash(), _p(METRICS)], env=env, capture_output=True, text=True, timeout=60)
        files = sorted(self.tf.iterdir())
        return r, "".join(f.read_text() for f in files if f.suffix == ".prom"), files

    @staticmethod
    def val(text, name):
        m = re.search(r"^%s(?:\{[^}]*\})?\s+(\S+)\s*$" % re.escape(name), text, re.M)
        return float(m.group(1)) if m else None

    def test_reports_lag_and_subscription_state(self):  # AC-18.2
        r, t, _ = self.run_script("t|12.5")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.val(t, "lims_ops_auditstore_up"), 1)
        self.assertEqual(self.val(t, "lims_ops_auditstore_subscription_enabled"), 1)
        self.assertAlmostEqual(self.val(t, "lims_ops_auditstore_lag_seconds"), 12.5, places=3)

    def test_lag_over_threshold_reported_as_is(self):  # AuditShippingLagging (> 300 s) evaluates this
        _, t, _ = self.run_script("t|301")
        self.assertEqual(self.val(t, "lims_ops_auditstore_lag_seconds"), 301)

    def test_disabled_subscription_is_visible(self):  # AuditShippingDown (page)
        _, t, _ = self.run_script("f|5")
        self.assertEqual(self.val(t, "lims_ops_auditstore_subscription_enabled"), 0)
        self.assertEqual(self.val(t, "lims_ops_auditstore_up"), 1)

    def test_unknown_lag_is_absent_never_zero(self):
        for out in ("t|", "t"):
            with self.subTest(out=out):
                _, t, _ = self.run_script(out)
                self.assertIsNone(self.val(t, "lims_ops_auditstore_lag_seconds"), t)
                self.assertEqual(self.val(t, "lims_ops_auditstore_subscription_enabled"), 1)

    def test_psql_failure_marks_down_without_stale_lag(self):
        self.run_script("t|1")
        _, t, _ = self.run_script("", rc=2)
        self.assertEqual(self.val(t, "lims_ops_auditstore_up"), 0, t)
        self.assertIsNone(self.val(t, "lims_ops_auditstore_lag_seconds"), "stale lag after failure")
        self.assertIsNone(self.val(t, "lims_ops_auditstore_subscription_enabled"))

    def test_garbage_output_is_not_turned_into_numbers(self):
        for out in ("t|abc", "t|1;rm -rf /", "x|5", "t|-3", "t|1 2"):
            with self.subTest(out=out):
                _, t, _ = self.run_script(out)
                lag = self.val(t, "lims_ops_auditstore_lag_seconds")
                self.assertTrue(lag is None or lag >= 0, t)
                self.assertNotIn("rm -rf", t)

    def test_atomic_single_prom_file(self):
        for out in ("t|1", "t|2"):
            _, _, files = self.run_script(out)
            self.assertEqual([f.suffix for f in files], [".prom"], [f.name for f in files])

    def test_type_lines_and_wire_options(self):
        _, t, _ = self.run_script("t|1")
        for m in ("lims_ops_auditstore_up", "lims_ops_auditstore_subscription_enabled", "lims_ops_auditstore_lag_seconds"):
            self.assertRegex(t, r"# TYPE %s gauge" % m)
        calls = (self.tmp / "calls.log").read_text()
        self.assertRegex(calls, r"(?:^|\s)(-w\b|--no-password)", "never hang on a password prompt")

    def test_query_uses_subscription_and_replicated_max_occurred_at(self):
        s = sql_only(self.src)
        self.assertRegex(s, r"pg_stat_subscription|pg_subscription")
        self.assertIn("occurred_at", s)

    def test_read_only_no_secrets_no_host_names(self):
        s = "\n".join(l for l in self.src.splitlines() if not l.strip().startswith("#"))
        self.assertIsNone(HOSTNAME_RE.search(s))
        self.assertNotRegex(s, r"PGPASSWORD|password=")
        self.assertNotRegex(s, r"(?i)\b(insert|update|delete|drop|alter|truncate)\b", "metrics script must be read-only")


if __name__ == "__main__":
    unittest.main()
