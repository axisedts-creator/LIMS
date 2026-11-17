"""T-12 live test (tester role): real streaming standby, replay lag under load, link-cut -> slot invalidated, primary stays small.

Runs only with LIMS_T12_LIVE=1 and PostgreSQL 17 server binaries on PATH (initdb, pg_ctl, pg_basebackup, psql), as a NON-root user
on Linux (CI/staging). Two scratch clusters on loopback, no real host touched; auth is `trust` on loopback because pg_hba/passfile
are covered by the static tests. The primary uses a tiny max_slot_wal_keep_size (48MB) so the 50GB production bound is exercised
at test scale; the production value itself is asserted statically (test_t12_standby.PrimarySlotBoundTest).
Proves: done_when "standby in recovery, replay lag < 60 s under load; slot bounded by max_slot_wal_keep_size" and
test "link-cut test (slot invalidation does not fill data-1)" (03-APP-FLOW s3.3).
Uses the committed infra/database/standby/standby.conf.j2 (rendered with standby_primary_port) via `include`.
"""
import os
import platform
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import jinja2

ROOT = Path(__file__).resolve().parents[3]
STANDBY_J2 = ROOT / "infra" / "database" / "standby" / "standby.conf.j2"
SCRIPT = ROOT / "infra" / "ansible" / "roles" / "standby" / "files" / "lims-standby-metrics.sh"
LIVE = (os.environ.get("LIMS_T12_LIVE") == "1" and platform.system() == "Linux" and os.geteuid() != 0
        and all(shutil.which(b) for b in ("initdb", "pg_ctl", "pg_basebackup", "psql")))
KEEP_MB = 48


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=kw.pop("timeout", 120), **kw)


def dir_mb(path):
    return sum(f.stat().st_size for f in Path(path).iterdir() if f.is_file()) / (1 << 20)


@unittest.skipUnless(LIVE, "set LIMS_T12_LIVE=1 on Linux (non-root) with PostgreSQL 17 binaries on PATH (CI/staging)")
class LiveStandby(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="t12live-"))
        cls.p1, cls.p2 = free_port(), free_port()
        cls.prim, cls.stby = cls.tmp / "primary", cls.tmp / "standby"
        sock = cls.tmp / "sock"
        sock.mkdir()
        cls.sock = sock
        assert run(["initdb", "-D", str(cls.prim), "-U", "postgres", "--auth=trust", "--wal-segsize=16"]).returncode == 0
        (cls.prim / "postgresql.auto.conf").write_text(
            f"port={cls.p1}\nlisten_addresses='127.0.0.1'\nunix_socket_directories='{sock}'\nwal_level=logical\n"
            f"max_wal_senders=10\nmax_replication_slots=10\nmax_slot_wal_keep_size={KEEP_MB}MB\nwal_keep_size=0\n"
            "max_wal_size=64MB\nmin_wal_size=32MB\narchive_mode=off\nfsync=off\nsynchronous_commit=off\n")
        with open(cls.prim / "pg_hba.conf", "a") as f:
            f.write("host replication all 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 trust\n")
        assert run(["pg_ctl", "-D", str(cls.prim), "-w", "-l", str(cls.tmp / "p.log"), "start"]).returncode == 0
        cls.psql_p("CREATE ROLE lims_replicator LOGIN REPLICATION; CREATE TABLE load(id bigserial, pad text);")
        assert run(["pg_basebackup", "-h", "127.0.0.1", "-p", str(cls.p1), "-U", "lims_replicator", "-D", str(cls.stby),
                    "-X", "stream", "-C", "--slot=dr1", "--write-recovery-conf"]).returncode == 0
        conf = jinja2.Environment(keep_trailing_newline=True).from_string(STANDBY_J2.read_text()).render(
            groups={"data": ["p"]}, hostvars={"p": {"wg_ip": "127.0.0.1"}}, standby_primary_port=cls.p1)
        (cls.tmp / "standby.conf").write_text(conf)
        with open(cls.stby / "postgresql.auto.conf", "a") as f:  # our committed settings win over pg_basebackup -R
            f.write(f"\nport={cls.p2}\nlisten_addresses='127.0.0.1'\nunix_socket_directories='{sock}'\n"
                    + "\n".join(l for l in conf.splitlines() if l.strip() and not l.lstrip().startswith("#")
                                and not l.startswith("passfile")) + "\n")
        assert run(["pg_ctl", "-D", str(cls.stby), "-w", "-l", str(cls.tmp / "s.log"), "start"]).returncode == 0

    @classmethod
    def tearDownClass(cls):
        for d in (cls.stby, cls.prim):
            run(["pg_ctl", "-D", str(d), "-m", "immediate", "stop"])
        shutil.rmtree(cls.tmp, True)

    @classmethod
    def psql_p(cls, sql):
        return run(["psql", "-h", "127.0.0.1", "-p", str(cls.p1), "-U", "postgres", "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql])

    @classmethod
    def psql_s(cls, sql):
        return run(["psql", "-h", "127.0.0.1", "-p", str(cls.p2), "-U", "postgres", "-X", "-A", "-t", "-c", sql])

    def test_1_standby_in_recovery_and_streaming_on_slot_dr1(self):
        self.assertEqual(self.psql_s("SELECT pg_is_in_recovery()").stdout.strip(), "t")
        self.assertEqual(self.psql_p("SELECT state||'|'||sync_state FROM pg_stat_replication").stdout.split("|")[0].strip(), "streaming")
        self.assertEqual(self.psql_p("SELECT active FROM pg_replication_slots WHERE slot_name='dr1'").stdout.strip(), "t")

    def test_2_replay_lag_under_60s_during_write_load_and_metric_matches(self):
        end, worst = time.time() + 20, 0.0
        while time.time() < end:
            self.assertEqual(self.psql_p("INSERT INTO load(pad) SELECT repeat('x',500) FROM generate_series(1,2000)").returncode, 0)
            r = self.psql_s("SELECT coalesce(extract(epoch FROM now()-pg_last_xact_replay_timestamp()),0)").stdout.strip()
            worst = max(worst, float(r or 0))
        self.assertLess(worst, 60, "replay lag %.1fs under load" % worst)
        n = self.psql_p("SELECT count(*) FROM load").stdout.strip()
        for _ in range(30):  # catches up once the load stops
            if self.psql_s("SELECT count(*) FROM load").stdout.strip() == n:
                break
            time.sleep(1)
        self.assertEqual(self.psql_s("SELECT count(*) FROM load").stdout.strip(), n)
        # the shipped metric script, pointed at the standby through libpq env vars
        tf = self.tmp / "tf"
        tf.mkdir(exist_ok=True)
        env = dict(os.environ, PGHOST="127.0.0.1", PGPORT=str(self.p2), PGUSER="postgres", PGDATABASE="postgres", TEXTFILE_DIR=str(tf))
        self.assertEqual(run(["bash", str(SCRIPT)], env=env).returncode, 0)
        prom = "".join(p.read_text() for p in tf.glob("*.prom"))
        self.assertIn("lims_ops_standby_in_recovery 1", prom)
        lag = [l for l in prom.splitlines() if l.startswith("lims_ops_standby_replay_lag_seconds")]
        self.assertTrue(lag and float(lag[0].split()[-1]) < 60, prom)

    def test_3_link_cut_invalidates_slot_and_primary_wal_stays_bounded(self):
        self.assertEqual(run(["pg_ctl", "-D", str(self.stby), "-m", "immediate", "-w", "stop"]).returncode, 0)  # the cut link
        before = dir_mb(self.prim / "pg_wal")
        for _ in range(12):  # ~12 x 32MB of WAL while nobody consumes the slot
            self.assertEqual(self.psql_p("INSERT INTO load(pad) SELECT repeat('y',1000) FROM generate_series(1,40000); "
                                         "SELECT pg_switch_wal(); CHECKPOINT;").returncode, 0)
        st = self.psql_p("SELECT wal_status FROM pg_replication_slots WHERE slot_name='dr1'").stdout.strip()
        self.assertEqual(st, "lost", "slot must be invalidated, not retain WAL without bound")
        reason = self.psql_p("SELECT invalidation_reason FROM pg_replication_slots WHERE slot_name='dr1'").stdout.strip()
        self.assertEqual(reason, "wal_removed")
        after = dir_mb(self.prim / "pg_wal")
        bound = KEEP_MB + 64 + 4 * 16  # keep size + max_wal_size + slack of four segments
        self.assertLess(after, bound, "pg_wal grew to %.0f MB (was %.0f); bound %d MB" % (after, before, bound))
        self.assertEqual(self.psql_p("INSERT INTO load(pad) VALUES ('still writable')").returncode, 0, "primary must keep accepting writes")

    def test_4_invalidated_slot_means_reseed_standby_cannot_resume(self):  # documents the runbook: re-seed, no silent success
        r = run(["pg_ctl", "-D", str(self.stby), "-w", "-t", "20", "-l", str(self.tmp / "s2.log"), "start"])
        time.sleep(3)
        lag_rows = self.psql_p("SELECT count(*) FROM pg_stat_replication").stdout.strip()
        self.assertEqual(lag_rows, "0", "a standby behind an invalidated slot must not be reported as streaming")


if __name__ == "__main__":
    unittest.main()
