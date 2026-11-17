"""T-15 live test (tester role): real logical replication primary -> audit store, AC-18.2 / AC-18.3, digest chain, drift on live catalogs.

Runs only with LIMS_T15_LIVE=1 and PostgreSQL 17 server binaries on PATH (initdb, pg_ctl, psql), NON-root Linux (CI/staging).
Scratch cluster on loopback (the LD-45 `lean` shape: publisher DB `app`, store DB `lims_audit` in the SAME cluster; the
subscription uses create_slot=false with a pre-created slot). NEVER RUN on this machine (no PG binaries) - py_compile only.
Proves: done_when "insert on primary visible in store < 60 s; publisher delete not propagated; role assertions pass; digest chain
computed; drift job fails on mismatched name/type/nullability" and the spike outcome "non-BYPASSRLS replication role streams
FORCE-RLS tables" (05-SCHEMA s4). Uses the committed schema.sql, digest.sql, auditstore_roles.sql, drift.py.
"""
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
AS = ROOT / "infra" / "auditstore"
ROLES_SQL = ROOT / "infra" / "tests" / "internal" / "auditstore_roles.sql"
LIVE = (os.environ.get("LIMS_T15_LIVE") == "1" and platform.system() == "Linux" and os.geteuid() != 0
        and all(shutil.which(b) for b in ("initdb", "pg_ctl", "psql")))

PRIMARY_DDL = """
CREATE ROLE lims_owner NOLOGIN;
CREATE ROLE lims_audit_ship LOGIN REPLICATION NOSUPERUSER NOBYPASSRLS PASSWORD 'ship';
CREATE SCHEMA audit AUTHORIZATION lims_owner; CREATE SCHEMA billing AUTHORIZATION lims_owner;
SET ROLE lims_owner;
CREATE TABLE audit.audit_log (id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid, schema_name text NOT NULL,
 table_name text NOT NULL, row_id uuid, action text NOT NULL, changed_columns text[] NOT NULL DEFAULT '{}', old_values jsonb,
 new_values jsonb, actor_id uuid, actor_type text NOT NULL, membership_id uuid, support_session_id uuid, request_id uuid,
 client_ip inet, user_agent text, detail jsonb, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
 created_by uuid, PRIMARY KEY (tenant_id, occurred_at, id));
CREATE TABLE audit.access_log (id uuid NOT NULL, tenant_id uuid NOT NULL, centre_id uuid, actor_id uuid NOT NULL,
 actor_type text NOT NULL, membership_id uuid, support_session_id uuid, action text NOT NULL, entity_type text NOT NULL,
 entity_id uuid, purpose_code text, outcome text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', request_id uuid, client_ip inet,
 user_agent text, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL, created_by uuid NOT NULL,
 PRIMARY KEY (tenant_id, occurred_at, id));
CREATE TABLE billing.activity_log (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, centre_id uuid, action text NOT NULL,
 document_kind text, document_id uuid, document_no text, actor_id uuid NOT NULL, actor_membership_id uuid, actor_type text NOT NULL,
 occurred_at timestamptz NOT NULL, request_id uuid, details jsonb NOT NULL DEFAULT '{}', is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL, created_by uuid NOT NULL);
ALTER TABLE audit.audit_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit.audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE audit.access_log ENABLE ROW LEVEL SECURITY; ALTER TABLE audit.access_log FORCE ROW LEVEL SECURITY;
ALTER TABLE billing.activity_log ENABLE ROW LEVEL SECURITY; ALTER TABLE billing.activity_log FORCE ROW LEVEL SECURITY;
RESET ROLE;
GRANT USAGE ON SCHEMA audit, billing TO lims_audit_ship;
GRANT SELECT ON audit.audit_log, audit.access_log, billing.activity_log TO lims_audit_ship;
SET ROLE lims_owner;
CREATE PUBLICATION lims_audit_ship FOR TABLE audit.audit_log, audit.access_log, billing.activity_log WITH (publish = 'insert');
"""
T1 = "00000000-0000-0000-0000-0000000000a1"
MAINT = (f"INSERT INTO audit.audit_log (id,tenant_id,schema_name,table_name,action,actor_type,occurred_at,created_at,detail) "
         f"VALUES (gen_random_uuid(),'{T1}','app','event_log','D','system',now(),now(),'{{\"maintenance\":\"app.purge_event_log\"}}')")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@unittest.skipUnless(LIVE, "set LIMS_T15_LIVE=1 on Linux (non-root) with PostgreSQL 17 binaries on PATH (CI/staging)")
class LiveAuditStore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="t15live-"))
        cls.port = free_port()
        d = cls.tmp / "pg"
        sock = cls.tmp / "sock"
        sock.mkdir()
        cls.sock = str(sock)
        assert cls.sh(["initdb", "-D", str(d), "-U", "postgres", "--auth=trust"]).returncode == 0
        (d / "postgresql.auto.conf").write_text(f"port={cls.port}\nlisten_addresses='127.0.0.1'\nunix_socket_directories='{sock}'\n"
                                                "wal_level=logical\nmax_replication_slots=10\nmax_wal_senders=10\nfsync=off\n")
        # review T-15 item 2: the shipping role authenticates with scram (password_required) like production; the scram
        # line comes FIRST, trust stays for the harness superuser only.
        (d / "pg_hba.conf").write_text("local all all trust\nhost app lims_audit_ship 127.0.0.1/32 scram-sha-256\n"
                                       "host all all 127.0.0.1/32 trust\nhost replication all 127.0.0.1/32 trust\n")
        assert cls.sh(["pg_ctl", "-D", str(d), "-l", str(cls.tmp / "log"), "-w", "start"]).returncode == 0
        cls.d = d
        cls.psql("postgres", "CREATE DATABASE app; CREATE DATABASE lims_audit;")
        cls.psql("app", PRIMARY_DDL)
        cls.psql_file("lims_audit", AS / "schema.sql", "-v", "audit_writer_pw=w", "-v", "audit_digest_pw=d", "-v", "audit_reader_pw=r",
                      "-v", "lims_monitor_pw=m")
        cls.psql("app", "SELECT pg_create_logical_replication_slot('audit_ship','pgoutput')")
        # review T-15 item 2: exactly the role task (tasks/main.yml): owner audit_writer (INSERT-only), run_as_owner = true,
        # pg_create_subscription, scram password in the conninfo (DECISION.md spike outcome).
        r = cls.psql("lims_audit", f"SET ROLE audit_writer; CREATE SUBSCRIPTION audit_ship CONNECTION 'host=127.0.0.1 port={cls.port} "
                     "dbname=app user=lims_audit_ship password=ship' PUBLICATION lims_audit_ship WITH (copy_data=false, streaming=on, "
                     "create_slot=false, slot_name='audit_ship', run_as_owner=true); RESET ROLE")
        assert r.returncode == 0, r.stderr

    @classmethod
    def tearDownClass(cls):
        cls.sh(["pg_ctl", "-D", str(cls.d), "-m", "immediate", "stop"])
        shutil.rmtree(cls.tmp, True)

    @staticmethod
    def sh(cmd, **kw):
        return subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 120), **kw)

    @classmethod
    def psql(cls, db, sql, role=None):
        cmd = ["psql", "-h", cls.sock, "-p", str(cls.port), "-U", role or "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql]
        return cls.sh(cmd)

    @classmethod
    def psql_file(cls, db, path, *args):
        return cls.sh(["psql", "-h", cls.sock, "-p", str(cls.port), "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", *args, "-f", str(path)])

    def wait_store(self, sql, want, secs=60):
        t0 = time.time()
        while time.time() - t0 < secs:
            if self.psql("lims_audit", sql).stdout.strip() == want:
                return time.time() - t0
            time.sleep(0.5)
        self.fail("store did not reach %r for %s within %d s" % (want, sql, secs))

    def test_insert_visible_in_store_under_60s_through_force_rls(self):  # AC-18.2 + RLS spike
        r = self.psql("app", MAINT)
        self.assertEqual(r.returncode, 0, r.stderr)
        took = self.wait_store("SELECT count(*)>0 FROM audit.audit_log WHERE detail->>'maintenance'='app.purge_event_log' AND actor_id IS NULL", "t")
        self.assertLess(took, 60)

    def test_publisher_delete_is_not_propagated(self):
        self.psql("app", MAINT)
        self.wait_store("SELECT count(*)>0 FROM audit.audit_log", "t")
        self.assertEqual(self.psql("app", "DELETE FROM audit.audit_log", role="postgres").returncode, 0)
        time.sleep(3)
        self.assertEqual(self.psql("lims_audit", "SELECT count(*)>0 FROM audit.audit_log").stdout.strip(), "t")

    def test_role_assertions_pass(self):  # AC-18.3
        r = self.psql_file("lims_audit", ROLES_SQL)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_writer_really_cannot_update_delete_truncate(self):
        for stmt in ("UPDATE audit.audit_log SET action='X'", "DELETE FROM audit.audit_log", "TRUNCATE audit.audit_log"):
            for role in ("audit_writer", "audit_digest", "audit_reader"):
                with self.subTest(stmt=stmt, role=role):
                    self.assertNotEqual(self.psql("lims_audit", stmt, role=role).returncode, 0)

    def test_digest_chain_computed_and_closed_days_never_rewritten(self):
        yday = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kathmandu') - interval '12 hours') AT TIME ZONE 'Asia/Kathmandu'"
        for _ in range(2):
            self.psql("app", MAINT.replace("now(),now()", f"{yday},{yday}", 1))
        self.wait_store("SELECT count(*)>=2 FROM audit.audit_log WHERE occurred_at < now() - interval '1 hour'", "t")
        self.assertEqual(self.psql_file("lims_audit", AS / "digest.sql").returncode, 0)
        q = "SELECT encode(chain_digest,'hex') FROM auditstore_meta.daily_digests WHERE octet_length(chain_digest)=32 ORDER BY business_date"
        before = self.psql("lims_audit", q).stdout
        self.assertTrue(before.strip(), "no digest row for yesterday")
        self.psql("lims_audit", "UPDATE audit.audit_log SET action='tampered'")  # superuser tampering
        self.assertEqual(self.psql_file("lims_audit", AS / "digest.sql").returncode, 0)
        self.assertTrue(self.psql("lims_audit", q).stdout.startswith(before), "closed-day digests are never rewritten")

    def test_missed_night_is_backfilled_into_the_chain(self):  # review T-15 item 3 / REQ-SEC-097: no silent hole in the chain
        T2 = "00000000-0000-0000-0000-0000000000a2"
        for ago in (3, 2, 1):  # 3 and 2 days ago = nights the job "missed"; 1 = tonight's "yesterday"
            ts = f"(date_trunc('day', now() AT TIME ZONE 'Asia/Kathmandu') - interval '{ago} days' + interval '12 hours') AT TIME ZONE 'Asia/Kathmandu'"
            self.psql("app", MAINT.replace(T1, T2).replace("now(),now()", f"{ts},{ts}", 1))
        self.wait_store(f"SELECT count(*)=3 FROM audit.audit_log WHERE tenant_id='{T2}'", "t")
        self.assertEqual(self.psql_file("lims_audit", AS / "digest.sql").returncode, 0)
        q = (f"SELECT count(*) || ':' || count(prev_digest) FROM auditstore_meta.daily_digests WHERE tenant_id='{T2}' "
             "AND source_table='audit.audit_log'")
        self.assertEqual(self.psql("lims_audit", q).stdout.strip(), "3:2", "days 3 and 2 must be digested too, each chained to the day before")
        chain = ("SELECT bool_and(d.prev_digest IS NOT DISTINCT FROM (SELECT p.chain_digest FROM auditstore_meta.daily_digests p WHERE "
                 "p.tenant_id=d.tenant_id AND p.source_table=d.source_table AND p.business_date < d.business_date "
                 f"ORDER BY p.business_date DESC LIMIT 1)) FROM auditstore_meta.daily_digests d WHERE d.tenant_id='{T2}'")
        self.assertEqual(self.psql("lims_audit", chain).stdout.strip(), "t")

    def test_drift_job_on_live_catalogs(self):
        q = ("SELECT json_agg(c) FROM (SELECT table_schema,table_name,column_name,data_type,udt_name,is_nullable FROM information_schema.columns "
             "WHERE (table_schema,table_name) IN (('audit','audit_log'),('audit','access_log'),('billing','activity_log'))) c")
        src = self.psql("app", q).stdout.strip()
        sub = self.psql("lims_audit", q).stdout.strip()
        a, b = self.tmp / "src.json", self.tmp / "sub.json"
        a.write_text(src)
        b.write_text(sub)
        run = lambda: subprocess.run([sys.executable, "-I", str(AS / "drift.py"), str(a), str(b)], capture_output=True, text=True).returncode
        self.assertEqual(run(), 0)
        self.psql("lims_audit", "ALTER TABLE audit.audit_log ALTER COLUMN actor_id SET NOT NULL")
        b.write_text(self.psql("lims_audit", q).stdout.strip())
        self.assertEqual(run(), 1, "nullability drift must fail the job")
        self.psql("lims_audit", "ALTER TABLE audit.audit_log ALTER COLUMN actor_id DROP NOT NULL")


if __name__ == "__main__":
    unittest.main()
