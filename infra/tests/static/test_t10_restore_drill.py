"""T-10 tests (tester role): monthly restore drill automation.

Covers 02-TRD s9.6, 03-APP-FLOW s4 (state machine, edge cases), AC-13.1..13.3, 07-SEC rows A2 / controls 2 and 6
(PHI only on ops-1 LUKS scratch, counts/timings only, never restored into staging), 06-PLAN row T-10,
LD-45 (both topology profiles: no host names, groups only).
Done when (T-10): drill restores repo2 to t-30 min, verify.sql runs, metrics + report PR produced, scratch LV removed;
`RestoreDrillOverdue` promtool test.

NOT provable here (real hosts / staging; see .orchestra/notes/T-10-tests.md): a real `pgbackrest restore`, real LVM/LUKS,
a real Postgres running verify.sql, the real PR, `promtool` when it is not on PATH (CI has it).
These tests prove the committed artefacts and the scripts' behaviour with faked pgbackrest/pg_isready/git/gh.

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ansible/playbooks/restore-drill.yml: YAML list of plays, every play `hosts: ops`, `become: true`. No literal host
   or profile names (data-1, dr-1, ops-1, prod-1, backup-1 ...) in it or in infra/drill/* (README.md excepted); cites LD-45.
   A `block:` holds lvcreate (VG vg_ops, LV name contains "drill") -> restore.sh -> verify.sql -> objects_sample.sh ->
   report.sh; its `rescue:` runs report.sh and ends with ansible.builtin.fail (a failed drill must not exit 0);
   its `always:` runs blkdiscard THEN lvremove, removes container drill-pg, the cipher-pass file and the lock.
   Lock /var/lock/lims-drill (flock or stat-and-fail). Offset var drill_target_offset_min. ops_audit via ci/ops-note.sh.
   The timer (OnCalendar, TimeoutStartSec <= 3h) may live in the playbook or in a file under infra/drill/.
 * infra/drill/restore.sh (bash; runs where pgbackrest/pg_isready are on PATH): env DRILL_TARGET_OFFSET_MIN (default 30),
   DRILL_ACCEPT_TIMEOUT_S (default 7200), PGDATA. Runs `pgbackrest ... --stanza=lims --repo=2 --type=time
   --target=<now-offset, ISO with explicit UTC offset> --target-action=promote restore`, starts Postgres, polls `pg_isready`.
   stdout: `target_time=<ts>` and `rto_seconds=<int>` (rto only when it accepted connections). Non-zero otherwise.
 * infra/drill/objects_sample.sh: env SRC_ROOT, REPLICA_ROOT, optional SRC_SSH / REPLICA_SSH (command prefix, empty =
   local), OBJ_SAMPLE_N (default 200), OBJ_SAMPLE_OUT (optional file, one sampled relative path per line).
   stdout `objects_sampled=<n>` `objects_mismatched=<n>`; non-zero when mismatched > 0 (missing replica file = mismatch).
 * infra/drill/report.sh: env DRILL_STATE (succeeded|succeeded_with_failures|failed|aborted), DRILL_RTO_SECONDS,
   DRILL_TARGET_TIME, DRILL_VERIFIED_LSN, DRILL_CHECKS_TOTAL, DRILL_CHECKS_FAILED, DRILL_OBJECTS_SAMPLED,
   DRILL_OBJECTS_MISMATCHED, TEXTFILE_DIR (writes restore_drill.prom, atomically), DRILL_LOG_DIR (writes <YYYY-MM-DD>*.md),
   DRILL_REPO_DIR (git workdir), DRILL_SKIP_PR=1 (no git/gh). Otherwise opens a PR with `gh pr create`, never pushing main.
 * infra/drill/verify.sql: psql variable :target_time; one result line per check containing PASS, FAIL or SKIP;
   no ON_ERROR_STOP (failures are counted, not fatal); counts only.
 * infra/drill/README.md: verified restore options + amcheck availability (TRD s9.5/s9.6 "verified in T-10").
 * RestoreDrillOverdue: infra/monitoring/rules/backup.rules.yml (T-19 extends the file), one rule severity=warn at 35 d and
   one severity=page at 40 d, team=ops; promtool file infra/monitoring/rules/tests/restore_drill_overdue.test.yml.
Stdlib + PyYAML. Missing file = FAIL (never skip). promtool: hard FAIL if CI=true and absent, else skipped.
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t10_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOK = ROOT / "infra" / "ansible" / "playbooks" / "restore-drill.yml"
DRILL = ROOT / "infra" / "drill"
RESTORE = DRILL / "restore.sh"
VERIFY = DRILL / "verify.sql"
OBJECTS = DRILL / "objects_sample.sh"
REPORT = DRILL / "report.sh"
README = DRILL / "README.md"
RULES = ROOT / "infra" / "monitoring" / "rules" / "backup.rules.yml"
PTEST = ROOT / "infra" / "monitoring" / "rules" / "tests" / "restore_drill_overdue.test.yml"
INVENTORIES = ROOT / "infra" / "ansible" / "inventories"

HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|dev-1)\b")
DAY = 86400


def read(p):
    if not p.is_file():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p.read_text(encoding="utf-8")


def code_lines(text):
    """Text without full-line comments (# and SQL --)."""
    return "\n".join(l for l in text.splitlines() if not re.match(r"^\s*(#|--)", l))


def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def drill_texts():
    """All files under infra/drill except the README, as {relname: text}."""
    if not DRILL.is_dir():
        raise AssertionError("missing dir infra/drill")
    return {p.relative_to(DRILL).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted(DRILL.rglob("*")) if p.is_file() and p.name != "README.md"}


# ================================================================ playbook (static)
def plays():
    doc = yaml.safe_load(read(PLAYBOOK))
    if not isinstance(doc, list) or not doc:
        raise AssertionError("restore-drill.yml must be a non-empty list of plays")
    return doc


def walk(tasks, ctx=()):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        yield t, ctx
        for k in ("block", "rescue", "always"):
            if k in t:
                yield from walk(t[k], ctx + (k,))


def all_tasks():
    out = []
    for p in plays():
        for sect in ("pre_tasks", "tasks", "post_tasks", "handlers"):
            out.extend(walk(p.get(sect)))
    return out


def tj(t):
    return json.dumps(t, default=str)


def first_idx(items, pat, want_ctx=None):
    """Index in document order of the first leaf task whose json matches pat (and, if given, sits in `want_ctx`)."""
    for i, (t, ctx) in enumerate(items):
        if "block" in t:
            continue
        if re.search(pat, tj(t)) and (want_ctx is None or (want_ctx in ctx) == True):
            return i
    return None


class PlaybookTest(unittest.TestCase):
    def setUp(self):
        self.text = read(PLAYBOOK)
        self.tasks = all_tasks()

    def test_parses_ops_only_become(self):  # 02-TRD 9.6 "on ops-1"; 07-SEC control 6: never staging/data hosts
        for p in plays():
            self.assertEqual(str(p.get("hosts")).strip(), "ops", "every play must be `hosts: ops`, got %r" % p.get("hosts"))
            self.assertTrue(p.get("become"), "play %r needs become: true (lvm, docker)" % p.get("name"))

    def test_no_literal_host_names_and_cites_ld45(self):  # LD-45: both profiles pass, names come from the inventory
        blobs = dict(drill_texts())
        blobs["restore-drill.yml"] = self.text
        for name, t in blobs.items():
            m = HOSTNAMES.search(code_lines(t))
            self.assertIsNone(m, "%s: literal host name %r (LD-45: use groups/inventory vars)" % (name, m and m.group(0)))
        self.assertIn("LD-45", self.text, "cite LD-45 in a comment")

    def test_exclusive_lock(self):  # 03-APP-FLOW 4.1 'no other drill running', 4.3 deploy blocks on the lock
        self.assertIn("/var/lock/lims-drill", self.text)
        self.assertRegex(self.text, r"flock|stat|creates|fail_msg|failed_when", "lock must be taken and refused when held")

    def test_step_order_in_block(self):  # 02-TRD 9.6 steps 1..5
        items = [(t, c) for t, c in self.tasks if "block" not in t]
        idx = [first_idx(items, p, None) for p in (r"lvcreate", r"restore\.sh", r"verify\.sql", r"objects_sample\.sh", r"report\.sh")]
        self.assertNotIn(None, idx, "playbook must reference lvcreate, restore.sh, verify.sql, objects_sample.sh, report.sh: %s" % idx)
        self.assertEqual(idx, sorted(idx), "steps out of order: %s" % idx)
        self.assertRegex(self.text, r"vg_ops")
        self.assertRegex(self.text, r"lvcreate[^\n]*\n?[^\n]*drill|drill[^\n]*lvcreate|lv_?name[^\n]*drill|name:\s*\S*drill\S*", "LV name must contain 'drill'")

    def test_always_discards_then_removes_everything(self):  # done_when "scratch LV removed"; 07-SEC 129
        blocks = [t for t, _ in self.tasks if "block" in t and "always" in t]
        main = [b for b in blocks if re.search(r"restore\.sh", tj(b["block"]))]
        self.assertTrue(main, "need block: (lvcreate..report.sh) with always: cleanup")
        always = main[0]["always"]
        self.assertTrue(all(re.search(r"lvcreate", tj(x)) is None for x in always), "never create the LV in always")
        seq = [tj(x) for x in always]
        d = next((i for i, s in enumerate(seq) if "blkdiscard" in s), None)
        r = next((i for i, s in enumerate(seq) if "lvremove" in s), None)
        self.assertIsNotNone(d, "always: needs blkdiscard")
        self.assertIsNotNone(r, "always: needs lvremove")
        self.assertLess(d, r, "blkdiscard must run before lvremove (TRD 9.6 step 6)")
        blob = " ".join(seq)
        self.assertRegex(blob, r"drill-pg", "always: remove container drill-pg")
        self.assertRegex(blob, r"/var/lock/lims-drill", "always: release the lock")
        self.assertRegex(blob, r"cipher|/run/lims/secrets", "always: remove the cipher-pass file")
        for s in seq:
            if re.search(r"blkdiscard|lvremove|drill-pg", s):
                self.assertNotRegex(s, r'"ignore_errors": true', "cleanup steps must not be swallowed")

    def test_failure_runs_report_then_fails_the_play(self):  # 03-APP-FLOW 4.1 failed -> cleaning, page; rc must be non-zero
        main = [t for t, _ in self.tasks if "block" in t and "rescue" in t and re.search(r"restore\.sh", tj(t["block"]))]
        self.assertTrue(main, "need rescue: on the drill block")
        resc = tj(main[0]["rescue"])
        self.assertRegex(resc, r"report\.sh")
        self.assertRegex(resc, r"failed|aborted", "rescue reports state failed/aborted")
        self.assertRegex(resc, r"ansible\.builtin\.fail|\"fail\"|meta", "rescue must re-fail the play (no silent rc 0)")

    def test_success_report_runs_after_scratch_lv_removed(self):  # T-10 review 1; 03-APP-FLOW 4.1 cleaning->succeeded guard
        # The success metric (lims_ops_restore_drill_last_success_timestamp_seconds) is a side effect of `succeeded`,
        # which is only legal once the LV is discarded AND removed. So the success report.sh must sit after the
        # main block's `always` (lvremove), never inside `block`.
        leaf = [(t, c) for t, c in self.tasks if "block" not in t]
        lv = next((i for i, (t, c) in enumerate(leaf) if "always" in c and "lvremove" in tj(t)), None)
        self.assertIsNotNone(lv, "need the lvremove task in always:")
        succ = [i for i, (t, c) in enumerate(leaf)
                if re.search(r"report\.sh", tj(t)) and "rescue" not in c and re.search(r"succeeded", tj(t))]
        self.assertTrue(succ, "need a success report.sh task (DRILL_STATE succeeded)")
        for i in succ:
            self.assertNotIn("block", leaf[i][1], "success report.sh must be outside `block:` (runs only after cleanup): %s" % leaf[i][0].get("name"))
            self.assertGreater(i, lv, "success report.sh must come after the `Remove the scratch LV` task: %s" % leaf[i][0].get("name"))
        end = next((i for i, (t, c) in enumerate(leaf) if "drill_ops_note" in tj(t)
                    and re.search(r"restore-drill end", tj(t))), None)
        if end is not None:
            self.assertLess(max(succ), end, "success report.sh must precede the `ops_audit - drill end` note")

    def test_scratch_container_egress_limited_to_dr_sftp(self):  # T-10 review 2; 02-TRD 9.6 step 1 "no network except wg0 to dr-1:2222"
        leaf = [(t, c) for t, c in self.tasks if "block" not in t]
        run = next((i for i, (t, c) in enumerate(leaf)
                    if '"docker", "run"' in tj(t) and re.search(r"drill_container|drill-pg", tj(t))), None)
        self.assertIsNotNone(run, "need the `docker run` of drill-pg")
        argv = leaf[run][0]["ansible.builtin.command"]["argv"]
        nets = [str(a) for a in argv if re.match(r"--net(work)?[= ]", str(a))] \
            + [str(argv[i + 1]) for i, a in enumerate(argv[:-1]) if str(a) in ("--network", "--net")]
        self.assertTrue(nets, "docker run for drill-pg needs --network=<dedicated network> (default bridge has open egress)")
        val = re.sub(r"^--net(work)?[= ]", "", nets[0])
        self.assertNotRegex(val, r"^(host|bridge|default|container:.*)$", "must be a dedicated user network, got %r" % val)
        fw = [(i, t, c) for i, (t, c) in enumerate(leaf) if re.search(r"DOCKER-USER", tj(t))]
        self.assertTrue(fw, "need a DOCKER-USER firewall rule restricting the scratch network's egress")
        adds = [(i, t) for i, t, c in fw if "always" not in c and "rescue" not in c]
        dels = [(i, t) for i, t, c in fw if "always" in c]
        self.assertTrue(adds, "egress rule must be added in the preparing phase (block), not only in always")
        self.assertLess(min(i for i, _ in adds), run, "egress rule must exist before the container starts")
        self.assertTrue(dels, "egress rule must be removed in always:")
        blob = " ".join(tj(t) for _, t in adds)
        ports = re.findall(r"(?:--dport|--destination-port|dport)\W{0,3}(\d+)", blob)
        self.assertTrue(ports, "egress allow rule must name a destination port")
        self.assertEqual(set(ports), {"2222"}, "only dr SFTP tcp/2222 may be allowed, got %s" % ports)
        self.assertRegex(blob, r"groups\[\W{0,3}dr\W{0,3}\]", "destination must come from the dr group (LD-45), not a literal")
        self.assertRegex(blob, r"wg_ip")
        self.assertRegex(blob, r"DROP|REJECT|drop|reject", "everything else from the scratch network must be dropped")
        self.assertRegex(" ".join(tj(t) for _, t in dels), r"-D\b|--delete|delete|flush|absent", "always: rule must be deleted")

    def test_scratch_instance_never_reachable(self):  # 03-APP-FLOW 4.3
        blob = code_lines(self.text) + "\n" + code_lines("\n".join(drill_texts().values()))
        self.assertRegex(blob, r"drill-pg")
        self.assertRegex(blob, r"listen_addresses\s*=?\s*['\"]?127\.0\.0\.1")
        self.assertRegex(blob, r"archive_mode\s*=?\s*['\"]?off")
        self.assertRegex(blob, r"max_wal_senders\s*=?\s*['\"]?0\b")
        self.assertNotRegex(blob, r"--network[= ]host|network_mode:\s*host", "no host networking")
        self.assertNotRegex(blob, r"published_ports|\s-p\s+\d+:\d+|--publish", "scratch container publishes no ports")

    def test_cipher_pass_only_tmpfs_never_argv_never_logged(self):  # AC-12.3, 07-SEC AB-7, 03-APP-FLOW 4.2 step 1
        self.assertRegex(self.text, r"/run/lims/secrets", "pass goes to tmpfs")
        self.assertRegex(self.text, r"sops", "pass comes from the secret store (SOPS, drill scope)")
        self.assertNotRegex(code_lines(self.text) + "\n".join(drill_texts().values()), r"--repo\d?-cipher-pass",
                            "pass must not be on a command line")
        for t, _ in self.tasks:
            s = tj(t)
            if re.search(r"cipher|sops", s, re.I) and "block" not in t:
                self.assertTrue(t.get("no_log") is True, "task touching the cipher pass needs no_log: true: %s" % t.get("name"))

    def test_offset_variable_and_audit_note(self):
        self.assertIn("drill_target_offset_min", self.text)
        self.assertRegex(self.text, r"ops-note\.sh", "drill start/end go to ops_audit via ci/ops-note.sh")

    def test_objects_and_billing_steps_present(self):  # TRD 9.6 steps 3 (billing dry run) and 4
        self.assertRegex(self.text, r"export-tenant-billing")
        self.assertRegex(self.text, r"dry[-_ ]?run")

    def test_timer_first_saturday_0200_npt(self):  # TRD 9.6 header; Sat 02:00 NPT == Fri 20:15 UTC
        blob = self.text + "\n".join(drill_texts().values())
        cal = re.findall(r"(?im)^\s*OnCalendar\s*=\s*(.+?)\s*$", blob)
        self.assertTrue(cal, "no OnCalendar for the monthly drill")
        ok = [c for c in cal if (re.search(r"\bSat\b", c) and re.search(r"\b0?1\.\.0?7\b", c) and re.search(r"\b02:00", c)
                                 and re.search(r"Kathmandu|NPT", c))
              or (re.search(r"\bFri\b", c) and re.search(r"\b20:15", c))]
        self.assertTrue(ok, "first Saturday 02:00 NPT, e.g. 'Sat *-*-01..07 02:00:00 Asia/Kathmandu': %s" % cal)
        self.assertRegex(blob, r"restore-drill", "timer unit must start this playbook")

    def test_service_timeout_at_most_3h(self):  # 03-APP-FLOW 4.3 lock held <= 3 h
        blob = self.text + "\n".join(drill_texts().values())
        m = re.search(r"(?im)^\s*TimeoutStartSec\s*=\s*(\S+)", blob)
        self.assertIsNotNone(m, "service needs TimeoutStartSec (<= 3h)")
        v = m.group(1)
        secs = {"h": 3600, "min": 60, "m": 60, "s": 1}
        mm = re.fullmatch(r"(\d+)(h|min|m|s)?", v)
        self.assertIsNotNone(mm, v)
        self.assertLessEqual(int(mm.group(1)) * secs.get(mm.group(2) or "s"), 3 * 3600, "TimeoutStartSec %s > 3h" % v)

    def test_inventories_define_ops_group(self):  # AC-13.3 same playbook against staging repos; LD-45 both profiles
        for env in ("dev", "staging", "prod"):
            doc = yaml.safe_load(read(INVENTORIES / env / "hosts.yml"))
            self.assertIn("ops", doc["all"]["children"], "%s inventory has no `ops` group" % env)


# ================================================================ restore.sh with faked pgbackrest / pg_isready
FAKE_PGBACKREST = r"""#!/usr/bin/env bash
echo "$*" >> "$FIX/calls.log"
sleep 2
exit "${FAKE_RESTORE_RC:-0}"
"""
FAKE_PG_ISREADY = r"""#!/usr/bin/env bash
n=$(cat "$FIX/isready.count" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FIX/isready.count"
[ -f "$FIX/never_ready" ] && exit 2
[ "$n" -ge 2 ] && { echo "/var/run/postgresql:5432 - accepting connections"; exit 0; }
echo "no response"; exit 2
"""
FAKE_OK = "#!/usr/bin/env bash\necho \"$(basename $0) $*\" >> \"$FIX/other.log\"\nexit 0\n"


def parse_target(s):
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)\s*$", s.strip().strip("'\""))
    if not m:
        raise AssertionError("target %r: need 'YYYY-MM-DD HH:MM:SS' + explicit UTC offset (Z|+00|+05:45)" % s)
    y, mo, d, h, mi, se, tz = m.groups()
    if tz == "Z":
        off = 0
    else:
        sign = -1 if tz[0] == "-" else 1
        digits = tz[1:].replace(":", "")
        off = sign * (int(digits[:2]) * 60 + (int(digits[2:4]) if len(digits) >= 4 else 0))
    dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(se), tzinfo=timezone(timedelta(minutes=off)))
    return dt.timestamp()


class RestoreScriptTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(RESTORE.is_file(), "missing infra/drill/restore.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t10r-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        for n, body in (("pgbackrest", FAKE_PGBACKREST), ("pg_isready", FAKE_PG_ISREADY), ("pg_ctl", FAKE_OK),
                        ("psql", FAKE_OK), ("postgres", FAKE_OK), ("docker", FAKE_OK)):
            (self.bin / n).write_bytes(body.replace("\r\n", "\n").encode())

    def run_script(self, extra_env=None, timeout=90):
        env = dict(os.environ, FIX=self.tmp.as_posix(), PGDATA=(self.tmp / "pgdata").as_posix(),
                   PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
                   PGBACKREST_REPO2_CIPHER_PASS="probe-cipher-pass-9f2c41d7a8b3")
        env.pop("DRILL_TARGET_OFFSET_MIN", None)
        env.update(extra_env or {})
        t0 = time.time()
        r = subprocess.run([_bash(), "-c", "cd '%s' && bash '%s'" % (self.tmp.as_posix(), RESTORE.as_posix())],
                           env=env, capture_output=True, text=True, timeout=timeout)
        return r, time.time() - t0

    def calls(self):
        p = self.tmp / "calls.log"
        return p.read_text() if p.exists() else ""

    @staticmethod
    def kvline(out, key):
        m = re.search(r"(?m)^%s=(.*)$" % re.escape(key), out)
        return m.group(1).strip() if m else None

    def test_restores_repo2_pitr_30_min_back_with_promote(self):  # AC-13.1
        r, _ = self.run_script()
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-600:])
        c = self.calls()
        self.assertRegex(c, r"\brestore\b")
        self.assertRegex(c, r"--stanza=lims")
        self.assertRegex(c, r"--repo[= ]2\b")
        self.assertNotRegex(c, r"--repo[= ]1\b", "drill restores repo2 only")
        self.assertRegex(c, r"--type[= ]time\b")
        self.assertRegex(c, r"--target-action[= ]promote\b")
        m = re.search(r"--target[= ](?:\"([^\"]+)\"|'([^']+)'|(\S+ \S+?(?= --|$)|\S+))", c)
        self.assertIsNotNone(m, "no --target in: " + c)
        tgt = parse_target(next(g for g in m.groups() if g))
        self.assertAlmostEqual(tgt, time.time() - 30 * 60, delta=150, msg="target must be now - 30 min")

    def test_offset_env_is_honoured(self):  # 02-TRD 11 table: drill_target_offset_min
        r, _ = self.run_script({"DRILL_TARGET_OFFSET_MIN": "45"})
        self.assertEqual(r.returncode, 0, r.stderr[-400:])
        tgt = parse_target(self.kvline(r.stdout, "target_time"))
        self.assertAlmostEqual(tgt, time.time() - 45 * 60, delta=150)

    def test_reports_target_time_and_measured_rto(self):  # AC-13.1 "duration = measured RTO"
        r, wall = self.run_script()
        tt = self.kvline(r.stdout, "target_time")
        rto = self.kvline(r.stdout, "rto_seconds")
        self.assertIsNotNone(tt, r.stdout)
        self.assertRegex(rto or "", r"^\d+$", r.stdout)
        self.assertGreaterEqual(int(rto), 2, "RTO covers the restore (fake sleeps 2 s) up to accepting connections")
        self.assertLessEqual(int(rto), wall + 1)
        self.assertGreaterEqual(int((self.tmp / "isready.count").read_text()), 2, "must poll pg_isready")

    def test_wal_gap_or_restore_failure_is_nonzero_without_rto(self):  # 03-APP-FLOW 4.3 WAL gap -> failed
        r, _ = self.run_script({"FAKE_RESTORE_RC": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(self.kvline(r.stdout, "rto_seconds"), "no RTO when restore failed")

    def test_never_ready_times_out_nonzero(self):  # 03-APP-FLOW 4.1 'accepts connections <= 2 h'
        (self.tmp / "never_ready").write_text("1")
        r, wall = self.run_script({"DRILL_ACCEPT_TIMEOUT_S": "4"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIsNone(self.kvline(r.stdout, "rto_seconds"))
        self.assertLess(wall, 60, "timeout knob must bound the wait")

    def test_default_timeout_is_two_hours(self):
        self.assertRegex(read(RESTORE), r"7200|2\s*\*\s*3600|2h", "default accept timeout 2 h (TRD/APP-FLOW [CONV])")

    def test_cipher_pass_never_on_argv_or_in_output(self):  # AC-12.3 / 07-SEC AB-7
        r, _ = self.run_script()
        probe = "probe-cipher-pass-9f2c41d7a8b3"
        self.assertNotIn(probe, self.calls())
        self.assertNotIn(probe, r.stdout + r.stderr)
        self.assertNotIn(probe, read(RESTORE))
        self.assertNotRegex(self.calls(), r"cipher")


# ================================================================ objects_sample.sh (local mode, real sha256sum)
class ObjectsSampleTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(OBJECTS.is_file(), "missing infra/drill/objects_sample.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t10o-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = self.tmp / "src"
        self.rep = self.tmp / "rep"
        self.cwd = self.tmp / "cwd"
        for d in (self.src, self.rep, self.cwd):
            d.mkdir()

    def make(self, names, replica=True):
        for i, n in enumerate(names):
            body = ("synthetic object %d\n" % i).encode()
            p = self.src / n
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(body)
            if replica:
                q = self.rep / n
                q.parent.mkdir(parents=True, exist_ok=True)
                q.write_bytes(body)

    def run_script(self, n=None):
        out = self.tmp / "sampled.txt"
        env = dict(os.environ, SRC_ROOT=self.src.as_posix(), REPLICA_ROOT=self.rep.as_posix(),
                   SRC_SSH="", REPLICA_SSH="", OBJ_SAMPLE_OUT=out.as_posix())
        env.pop("OBJ_SAMPLE_N", None)
        if n is not None:
            env["OBJ_SAMPLE_N"] = str(n)
        r = subprocess.run([_bash(), "-c", "cd '%s' && bash '%s'" % (self.cwd.as_posix(), OBJECTS.as_posix())],
                           env=env, capture_output=True, text=True, timeout=120)
        sampled = out.read_text().splitlines() if out.exists() else []
        return r, sampled

    @staticmethod
    def kv(out, k):
        m = re.search(r"(?m)^%s=(\d+)\s*$" % k, out)
        return int(m.group(1)) if m else None

    def test_samples_200_distinct_of_500_all_match(self):  # AC-14.3, TRD 9.6 step 4
        self.make(["o/%03d/obj-%04d.bin" % (i % 7, i) for i in range(500)])
        r, s1 = self.run_script()
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-500:])
        self.assertEqual(self.kv(r.stdout, "objects_sampled"), 200)
        self.assertEqual(self.kv(r.stdout, "objects_mismatched"), 0)
        self.assertEqual(len(s1), 200)
        self.assertEqual(len(set(s1)), 200, "sample must be without replacement")
        for rel in s1:
            self.assertTrue((self.src / rel.lstrip("./")).is_file(), rel)

    def test_sample_is_random_between_runs(self):
        self.make(["obj-%04d.bin" % i for i in range(500)])
        _, a = self.run_script()
        _, b = self.run_script()
        self.assertNotEqual(sorted(a), sorted(b), "two runs drew the identical 200 of 500")

    def test_fewer_than_n_samples_all(self):
        self.make(["obj-%02d.bin" % i for i in range(37)])
        r, s = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr[-300:])
        self.assertEqual(self.kv(r.stdout, "objects_sampled"), 37)

    def test_corrupt_replica_object_fails(self):  # all must match
        self.make(["obj-%03d.bin" % i for i in range(200)])
        (self.rep / "obj-100.bin").write_bytes(b"tampered\n")
        r, _ = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.kv(r.stdout, "objects_mismatched"), 1)

    def test_missing_replica_object_counts_as_mismatch(self):
        self.make(["obj-%03d.bin" % i for i in range(200)])
        (self.rep / "obj-007.bin").unlink()
        r, _ = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.kv(r.stdout, "objects_mismatched"), 1)

    def test_hostile_file_names_are_data_not_commands(self):  # adversarial: names reach ssh/remote shells
        names = ["x $(touch PWNED1).bin", "y;touch PWNED2.bin", "it's `touch PWNED3`.bin", "plain with spaces.bin"]
        self.make(names)
        r, _ = self.run_script()
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-500:])
        self.assertEqual(self.kv(r.stdout, "objects_sampled"), 4)
        for f in ("PWNED1", "PWNED2", "PWNED3"):
            self.assertFalse(list(self.tmp.rglob(f + "*")), "file name was executed: " + f)


# ================================================================ report.sh
OLD_TS = 1700000000
FAKE_GIT = "#!/usr/bin/env bash\necho \"$*\" >> \"$FIX/git.log\"\nexit 0\n"
FAKE_GH = "#!/usr/bin/env bash\necho \"$*\" >> \"$FIX/gh.log\"\nexit \"${FAKE_GH_RC:-0}\"\n"
GOOD = {"DRILL_STATE": "succeeded", "DRILL_RTO_SECONDS": "1234", "DRILL_TARGET_TIME": "2026-11-07 01:30:00+00",
        "DRILL_VERIFIED_LSN": "0/16B3748", "DRILL_CHECKS_TOTAL": "9", "DRILL_CHECKS_FAILED": "0",
        "DRILL_OBJECTS_SAMPLED": "200", "DRILL_OBJECTS_MISMATCHED": "0"}


class ReportScriptTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(REPORT.is_file(), "missing infra/drill/report.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t10p-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.prom = self.tmp / "prom"
        self.repo = self.tmp / "repo"
        self.logd = self.repo / "infra" / "runbooks" / "drill-log"
        for d in (self.bin, self.prom, self.repo):
            d.mkdir()
        (self.bin / "git").write_bytes(FAKE_GIT.encode())
        (self.bin / "gh").write_bytes(FAKE_GH.encode())

    def run_script(self, env_over=None, pr=False, prior=None):
        if prior is not None:
            (self.prom / "restore_drill.prom").write_text(prior)
        env = dict(os.environ, FIX=self.tmp.as_posix(), TEXTFILE_DIR=self.prom.as_posix(),
                   DRILL_LOG_DIR=self.logd.as_posix(), DRILL_REPO_DIR=self.repo.as_posix(),
                   PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
                   PGPASSWORD="probe-pgpass-77aa31", PGBACKREST_REPO2_CIPHER_PASS="probe-cipher-pass-9f2c41d7a8b3")
        for k in GOOD:
            env.pop(k, None)
        env.update(GOOD)
        if not pr:
            env["DRILL_SKIP_PR"] = "1"
        env.update(env_over or {})
        for k in [k for k, v in env.items() if v is None]:
            del env[k]
        r = subprocess.run([_bash(), "-c", "cd '%s' && bash '%s'" % (self.tmp.as_posix(), REPORT.as_posix())],
                           env=env, capture_output=True, text=True, timeout=60)
        return r

    def prom_text(self):
        return "".join(p.read_text() for p in sorted(self.prom.glob("*.prom")))

    @staticmethod
    def metric(text, name):
        return [float(m.group(2)) for m in re.finditer(r"(?m)^%s(\{[^}]*\})?\s+([0-9.eE+-]+)\s*$" % re.escape(name), text)]

    def md(self):
        return sorted(self.logd.glob("*.md")) if self.logd.is_dir() else []

    def test_success_writes_the_three_metrics(self):  # AC-13.1, TRD 9.6 step 5
        r = self.run_script()
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-500:])
        t = self.prom_text()
        ts = self.metric(t, "lims_ops_restore_drill_last_success_timestamp_seconds")
        self.assertEqual(len(ts), 1, t)
        self.assertAlmostEqual(ts[0], time.time(), delta=120)
        self.assertEqual(self.metric(t, "lims_ops_restore_drill_rto_seconds"), [1234.0])
        self.assertEqual(self.metric(t, "lims_ops_restore_drill_checks_failed"), [0.0])

    def test_prom_file_is_valid_exposition(self):  # adversarial: no garbage the textfile collector would reject
        self.run_script()
        for line in self.prom_text().splitlines():
            if line.strip() and not line.startswith("#"):
                self.assertRegex(line, r"^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?[0-9.eE+]+$", line)

    def test_failed_checks_do_not_refresh_success_timestamp(self):  # 03-APP-FLOW 4.1 only on `succeeded`
        prior = "lims_ops_restore_drill_last_success_timestamp_seconds %d\n" % OLD_TS
        r = self.run_script({"DRILL_STATE": "succeeded_with_failures", "DRILL_CHECKS_FAILED": "2"}, prior=prior)
        t = self.prom_text()
        self.assertEqual(self.metric(t, "lims_ops_restore_drill_last_success_timestamp_seconds"), [float(OLD_TS)],
                         "last-success must survive a failed drill, else RestoreDrillOverdue could never fire")
        self.assertEqual(self.metric(t, "lims_ops_restore_drill_checks_failed"), [2.0])

    def test_failed_and_aborted_never_write_success_timestamp(self):
        for st in ("failed", "aborted"):
            for f in self.prom.glob("*"):
                f.unlink()
            self.run_script({"DRILL_STATE": st, "DRILL_RTO_SECONDS": None, "DRILL_VERIFIED_LSN": None})
            self.assertEqual(self.metric(self.prom_text(), "lims_ops_restore_drill_last_success_timestamp_seconds"), [],
                             "state %s must not create a success timestamp" % st)

    def test_markdown_report_has_timings_and_counts(self):  # AC-13.1 drill log: duration, target time, verified LSN
        self.run_script()
        files = self.md()
        self.assertEqual(len(files), 1, "one Markdown report in DRILL_LOG_DIR")
        self.assertRegex(files[0].name, r"^\d{4}-\d{2}-\d{2}")
        body = files[0].read_text()
        for needle in ("1234", "2026-11-07 01:30:00+00", "0/16B3748", "200", "succeeded"):
            self.assertIn(needle, body)

    def test_no_secret_in_report_metrics_or_output(self):  # 07-SEC control 2: counts and timings only
        r = self.run_script(pr=True)
        blob = self.prom_text() + r.stdout + r.stderr + "".join(p.read_text() for p in self.md())
        for probe in ("probe-pgpass-77aa31", "probe-cipher-pass-9f2c41d7a8b3"):
            self.assertNotIn(probe, blob)

    def test_hostile_values_are_rejected_not_executed(self):  # adversarial: env comes from other tools' output
        evil = {"DRILL_VERIFIED_LSN": '0/1"; touch PWNED_LSN; echo "',
                "DRILL_RTO_SECONDS": "1; touch PWNED_RTO",
                "DRILL_CHECKS_FAILED": "0\nlims_ops_restore_drill_checks_failed 0"}
        self.run_script(evil)
        self.assertFalse(list(self.tmp.rglob("PWNED*")), "value was executed")
        for line in self.prom_text().splitlines():
            if line.strip() and not line.startswith("#"):
                self.assertRegex(line, r"^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})?\s+-?[0-9.eE+]+$", line)
        self.assertNotIn("PWNED", self.prom_text() + "".join(p.read_text() for p in self.md()))
        self.assertLessEqual(len(self.metric(self.prom_text(), "lims_ops_restore_drill_checks_failed")), 1)

    def test_unknown_state_fails_closed(self):
        r = self.run_script({"DRILL_STATE": "great"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.metric(self.prom_text(), "lims_ops_restore_drill_last_success_timestamp_seconds"), [])

    def test_opens_pr_and_never_pushes_main(self):  # TRD 9.6 step 5 "via a PR from the runner"
        r = self.run_script(pr=True)
        self.assertEqual(r.returncode, 0, (r.stdout + r.stderr)[-500:])
        gh = (self.tmp / "gh.log").read_text() if (self.tmp / "gh.log").exists() else ""
        self.assertRegex(gh, r"\bpr\s+create\b", "gh pr create not called")
        git = (self.tmp / "git.log").read_text() if (self.tmp / "git.log").exists() else ""
        for line in git.splitlines():
            if re.search(r"\bpush\b", line):
                self.assertNotRegex(line, r"\b(main|master)\b|--force|\s-f\b", "push of main/force: " + line)
            self.assertNotIn("--no-verify", line)

    def test_skip_pr_flag_touches_no_git(self):
        self.run_script(pr=False)
        self.assertFalse((self.tmp / "git.log").exists() or (self.tmp / "gh.log").exists(), "DRILL_SKIP_PR=1 must not call git/gh")

    def test_pr_failure_does_not_lose_metrics(self):  # metrics first, PR second
        (self.bin / "gh").write_bytes(FAKE_GH.encode())
        self.run_script({"FAKE_GH_RC": "1"}, pr=True)
        self.assertEqual(self.metric(self.prom_text(), "lims_ops_restore_drill_rto_seconds"), [1234.0])


# ================================================================ verify.sql (static; no Postgres on the tester box)
class VerifySqlTest(unittest.TestCase):
    def setUp(self):
        self.raw = read(VERIFY)
        self.sql = code_lines(self.raw)

    def test_recovery_ended(self):
        self.assertRegex(self.sql, r"pg_is_in_recovery\(\)")

    def test_audit_recency_within_45_min_of_target(self):  # TRD 9.6 step 3
        self.assertRegex(self.sql, r"max\(\s*occurred_at\s*\)")
        self.assertRegex(self.sql, r"audit\.audit_log")
        self.assertRegex(self.sql, r":'?target_time'?", "uses psql variable target_time")
        self.assertRegex(self.sql, r"45\s*(min|minutes)|interval\s+'45", "45 min window")

    def test_per_tenant_counts_for_active_tenants(self):  # TRD 9.6 step 3
        for t in ("billing.invoices", "audit.audit_log", "core.tenants"):
            self.assertIn(t, self.sql)
        self.assertRegex(self.sql, r"tenant_id")
        self.assertRegex(self.sql, r"(?i)active")
        self.assertRegex(self.sql, r"(?i)count\(")

    def test_amcheck_20_largest_with_skip_and_error_capture(self):  # TRD 9.6 step 3, edge: failures counted, not fatal
        self.assertRegex(self.sql, r"bt_index_check")
        self.assertRegex(self.sql, r"pg_relation_size")
        self.assertRegex(self.sql, r"(?i)limit\s+20\b")
        self.assertRegex(self.sql, r"pg_available_extensions|pg_extension", "amcheck availability probed")
        self.assertRegex(self.sql, r"(?i)\bSKIP\b")
        self.assertRegex(self.sql, r"(?is)exception\s+when", "bt_index_check raises on corruption: catch and count")

    def test_failures_counted_not_fatal(self):  # 03-APP-FLOW 4.1 verifying: 'failures counted, not fatal'
        self.assertNotRegex(self.sql, r"(?i)ON_ERROR_STOP\s+(on|1|true)")
        self.assertRegex(self.sql, r"\bPASS\b")
        self.assertRegex(self.sql, r"\bFAIL\b")

    def test_emits_verified_lsn(self):  # AC-13.1 'verified LSN'
        self.assertRegex(self.sql, r"pg_current_wal_lsn\(\)|pg_last_wal_replay_lsn\(\)|pg_control_checkpoint\(\)")

    def test_counts_only_no_row_contents(self):  # 03-APP-FLOW 4.3 / 07-SEC control 2
        self.assertNotRegex(self.sql, r"(?i)select\s+\*")
        stripped = re.sub(r"'[^']*'", "''", self.sql)
        for w in ("name", "phone", "email", "address", "dob", "birth", "patient", "result", "value", "signature", "barcode"):
            self.assertNotRegex(stripped, r"(?i)\b%s\w*\b" % w, "verify.sql touches PHI-class column/word %r" % w)

    def test_no_writes(self):  # scratch DB is a copy, but verify must stay read-only
        self.assertNotRegex(self.sql, r"(?i)\b(insert|update|delete|drop|truncate|alter|create)\b(?!\s+extension)")


# ================================================================ README (verified options)
class ReadmeTest(unittest.TestCase):
    def setUp(self):
        self.t = read(README)

    def test_records_verified_restore_options(self):  # TRD 9.5/9.6 'options verified in T-10'
        for needle in ("--type=time", "--target-action=promote", "--type=standby", "--repo=2", "2.60"):
            self.assertIn(needle, self.t)

    def test_records_amcheck_availability(self):  # TRD 9.6 'extension availability in image verified in T-10'
        self.assertRegex(self.t, r"(?is)amcheck.{0,200}(available|not available|unavailable|skipped)")


# ================================================================ RestoreDrillOverdue (AC-13.2)
def _secs(d):
    m = re.fullmatch(r"(\d+)(s|m|h|d)", str(d).strip())
    return int(m.group(1)) * {"s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)] if m else int(d)


def overdue_rules():
    doc = yaml.safe_load(read(RULES))
    return [r for g in doc["groups"] for r in g["rules"] if r.get("alert") == "RestoreDrillOverdue"]


class OverdueRuleTest(unittest.TestCase):
    METRIC = "lims_ops_restore_drill_last_success_timestamp_seconds"

    def test_warn_at_35d_and_page_at_40d(self):  # 02-TRD 11.3, 04 I3
        rules = overdue_rules()
        by_sev = {r["labels"]["severity"]: r for r in rules}
        self.assertEqual(sorted(by_sev), ["page", "warn"], "need one warn and one page RestoreDrillOverdue: %s" % sorted(by_sev))
        for sev, days in (("warn", 35), ("page", 40)):
            e = re.sub(r"\s+", "", by_sev[sev]["expr"])
            self.assertIn(self.METRIC, e)
            self.assertRegex(e, r"time\(\)-.*%s|%s.*time\(\)" % (self.METRIC, self.METRIC))
            self.assertRegex(e, r"(%d\*86400|%d\*24\*3600|%d)" % (days, days, days * DAY), "%s threshold %d d" % (sev, days))

    def test_rule_hygiene(self):  # same conventions as T-20/T-21
        for r in overdue_rules():
            self.assertEqual(r["labels"].get("team"), "ops")
            self.assertTrue(r["annotations"].get("summary"))
            self.assertEqual(r["annotations"].get("runbook_url", "").lower(), "infra/runbooks/backup.md#restoredrilloverdue")
            self.assertNotRegex(json.dumps(r), r"@[A-Za-z0-9-]+\.[A-Za-z]{2,}", "no e-mail address in a rule")


class PromtoolFileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.doc = yaml.safe_load(read(PTEST))
        cls.cases = cls.doc["tests"]

    def expects(self):
        return [(c, e) for c in self.cases for e in c.get("alert_rule_test", []) if e["alertname"] == "RestoreDrillOverdue"]

    def test_rule_files_point_at_backup_rules(self):
        rf = [(PTEST.parent / p).resolve() for p in self.doc["rule_files"]]
        self.assertIn(RULES.resolve(), rf)
        self.assertTrue(self.doc.get("evaluation_interval"))

    def test_covers_before_after_and_reset(self):  # AC-13.2: 34 d quiet, 36 d warn, fresh success quiet
        # The page rule (40 d) is checked statically above, not via promtool: whether the warn rule stays active
        # beyond 40 d is the writer's choice, so the exp_alerts set past 40 d is not fixed by the spec.
        es = self.expects()
        self.assertTrue(es, "no RestoreDrillOverdue expectations")
        quiet = [e for _, e in es if not e.get("exp_alerts")]
        warn = [e for _, e in es if any(a["exp_labels"].get("severity") == "warn" for a in e.get("exp_alerts") or [])]
        self.assertTrue(quiet and warn, "need not-firing and warn cases")
        self.assertTrue(any(_secs(e["eval_time"]) < 35 * DAY for e in quiet), "a case just under 35 d must be quiet")
        self.assertTrue(any(35 * DAY < _secs(e["eval_time"]) < 40 * DAY for e in warn), "a warn case between 35 d and 40 d")
        self.assertTrue(any(_secs(e["eval_time"]) >= 40 * DAY for e in quiet),
                        "a case with a recent success (age < 35 d) late in the series must be quiet")
        for e in warn:
            for a in e["exp_alerts"]:
                self.assertEqual(a["exp_labels"].get("team"), "ops")

    def test_labels_phi_free_and_synthetic(self):
        blob = PTEST.read_text(encoding="utf-8")
        self.assertNotRegex(blob, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")

    def test_promtool_test_rules(self):
        if not shutil.which("promtool"):
            if os.environ.get("CI") == "true":
                self.fail("promtool missing in CI")
            self.skipTest("promtool not on PATH (CI: promtool test rules)")
        r = subprocess.run(["promtool", "test", "rules", PTEST.name], capture_output=True, text=True, cwd=str(PTEST.parent))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_promtool_check_rules(self):
        if not shutil.which("promtool"):
            if os.environ.get("CI") == "true":
                self.fail("promtool missing in CI")
            self.skipTest("promtool not on PATH (CI: promtool check rules)")
        r = subprocess.run(["promtool", "check", "rules", str(RULES)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
