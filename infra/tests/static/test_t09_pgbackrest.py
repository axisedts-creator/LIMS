"""T-09 tests (tester role): pgBackRest in the derived DB image, repo1 + repo2, encryption, async archive, metrics.

Covers 02-TRD s9.1-s9.4, s7.7 (archive_command), AC-12.1..12.4, 07-SEC AB-7 / row A2 (cipher passes), 06-PLAN row T-09, R8.
Done when (T-09): check ok on both repos; full+incr; aes-256-cbc on both; dr-1 holds no cipher pass, repo1 pass only on
data-1 tmpfs; the three WAL metrics exported; multi-repo failure behaviour + WAL/day recorded; DECISION.md records
pgBackRest-or-WAL-G.

NOT provable here (needs real hosts / CI, marked in .orchestra/notes/T-09-tests.md): real build of pgBackRest 2.60.0 on
the Alpine base, `pgbackrest check`/backup against live repos, real WAL volume. These tests prove the committed
artefacts (Dockerfile, conf template, role, timers, metrics script behaviour with a faked pgbackrest/psql, DECISION.md).

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/database/pgbackrest/pgbackrest.conf.j2 renders with: groups, hostvars[h].wg_ip, inventory_hostname,
   db_primary_wg_ip, archive_timeout_s (+ any other var; unknown vars render as UNDEF_<name>). Section [global] + [lims].
 * Cipher passes are NEVER in the template; an include file is rendered by the role onto tmpfs under
   /run/lims/secrets/pgbackrest (mounted at /run/secrets/pgbackrest in the container, TRD s7.2).
 * Role infra/ansible/roles/pgbackrest/** holds the systemd timers (UTC in the unit, TRD s9.3); it is applied only to `data`.
 * pgbackrest_metrics.sh: run with bash; calls `pgbackrest` and `psql` found on PATH; writes Prometheus text to stdout
   OR to $TEXTFILE_DIR/*.prom. Metric labels: repo="1"|"2" (or "repo1"/"repo2"), type="full|diff|incr".
 * `pgbackrest info --output=json` / `repo-ls --output=json` shapes used by the fakes follow pgbackrest.org as the tester
   remembers it (UNVERIFIED; the writer verifies names in T-09 and, if they differ, files a dispute with the real output).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t09_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
IMG = ROOT / "infra" / "images" / "postgres-pgbackrest" / "Dockerfile"
CONF_J2 = ROOT / "infra" / "database" / "pgbackrest" / "pgbackrest.conf.j2"
ZZ_J2 = ROOT / "infra" / "database" / "postgresql" / "zz-lims.conf.j2"
ROLE = ROOT / "infra" / "ansible" / "roles" / "pgbackrest"
PLAYBOOKS = ROOT / "infra" / "ansible" / "playbooks"
METRICS = ROOT / "infra" / "monitoring" / "textfile" / "pgbackrest_metrics.sh"
DECISION = ROOT / "infra" / "compose" / "supabase" / "DECISION.md"
SCHEMAS = ROOT / "infra" / "secrets" / "schema"

WG = {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"}


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


def _ctx(dr=True):
    groups = {"data": ["data-1"], "app": ["app-1"], "dr": ["dr-1"] if dr else [], "ops": ["ops-1"]}
    return {"app_db_name": "postgres", "wg_ip": WG["data-1"], "groups": groups,
            "hostvars": {h: {"wg_ip": ip} for h, ip in WG.items()}, "db_primary_wg_ip": WG["data-1"],
            "docker_subnets": {k: "172.30.%d.0/24" % i for i, k in
                               enumerate(["edge", "app", "auth", "render", "db", "egress"], 10)},
            "archive_timeout_s": 60, "inventory_hostname": "data-1"}


def render(path, dr=True):
    if not path.is_file():
        raise AssertionError("missing file %s" % path.relative_to(ROOT).as_posix())
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
    return env.from_string(path.read_text(encoding="utf-8")).render(**_ctx(dr))


def kv(text, section=None):
    """key -> value for lines in [section] (None = all sections). '; comment' tails stripped."""
    out, cur = {}, None
    for raw in text.splitlines():
        line = raw.split(" ;")[0].strip()
        if not line or line.startswith(("#", ";")):
            continue
        m = re.match(r"^\[(.+)\]$", line)
        if m:
            cur = m.group(1)
            continue
        if "=" in line and (section is None or cur == section):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def role_text():
    if not ROLE.is_dir():
        raise AssertionError("missing dir infra/ansible/roles/pgbackrest")
    files = [p for p in sorted(ROLE.rglob("*")) if p.is_file()]
    if not files:
        raise AssertionError("infra/ansible/roles/pgbackrest is empty")
    return {p.relative_to(ROLE).as_posix(): p.read_text(encoding="utf-8") for p in files}


# ---------------------------------------------------------------- Dockerfile (TRD s9.1)
class DockerfileTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(IMG.is_file(), "missing infra/images/postgres-pgbackrest/Dockerfile")
        self.text = IMG.read_text(encoding="utf-8")
        self.lines = [l.strip() for l in self.text.splitlines() if l.strip() and not l.strip().startswith("#")]
        self.froms = [l for l in self.lines if re.match(r"(?i)^FROM\b", l)]

    def test_builder_stage_and_pinned_final_base(self):
        self.assertGreaterEqual(len(self.froms), 2, "TRD s9.1: pgBackRest is built in a builder stage")
        self.assertRegex(self.froms[0], r"(?i)\bAS\s+\w+", "first stage must be named")
        for f in self.froms:  # builder on the image's base (TRD s9.1) and final = same pinned base
            self.assertRegex(f, r"supabase/postgres@sha256:[0-9a-f]{64}", "base must be digest-pinned: " + f)

    def test_pinned_release_tarball_with_checksum(self):
        t = self.text
        self.assertIn("2.60.0", t, "TRD s2: pgBackRest 2.60.0")
        self.assertRegex(t, r"release/2\.60\.0|2\.60\.0\.tar", "must fetch the 2.60.0 release tarball")
        self.assertRegex(t, r"(?m)^ARG PGBACKREST_TARBALL_SHA256=[0-9a-f]{64}\s*$", "tarball sha256 must be recorded (TRD s9.1)")
        self.assertRegex(t, r"sha256sum\s+(-c|--check)", "tarball must be verified with sha256sum -c")
        self.assertNotRegex(t, r"(?i)pgbackrest.*(/master|/main|latest)", "no floating ref")

    def test_binary_copied_into_final_stage(self):
        self.assertTrue(any(re.match(r"(?i)^COPY\s+--from=", l) and "pgbackrest" in l.lower() for l in self.lines),
                        "final stage must COPY --from=<builder> the pgbackrest binary")

    def test_no_secrets_or_config_baked(self):
        for l in self.lines:
            self.assertNotRegex(l, r"(?i)cipher[-_]?pass", "cipher pass in image: " + l)
            self.assertNotRegex(l, r"(?i)^(ENV|ARG)\s+\w*(PASSWORD|SECRET|TOKEN|PASS)\w*\s*=\s*\S", "secret in image: " + l)
            self.assertFalse(re.match(r"(?i)^(COPY|ADD)\b(?!.*--from=).*(pgbackrest\.conf|zz-lims|pg_hba)", l),
                             "config is mounted by compose / rendered by the role, not baked: " + l)

    def test_final_stage_not_root(self):
        final = self.text[self.text.lower().rfind("\nfrom "):]
        users = re.findall(r"(?im)^USER\s+(\S+)", final)
        if users:
            self.assertNotIn(users[-1], ("root", "0"), "image must not end as root")


# ---------------------------------------------------------------- pgbackrest.conf.j2 (TRD s9.2; AC-12.1/12.3)
class ConfTemplateTest(unittest.TestCase):
    def setUp(self):
        self.out = render(CONF_J2)
        self.g = kv(self.out, "global")

    def test_stanza_section(self):
        s = kv(self.out, "lims")
        self.assertEqual(s.get("pg1-path"), "/var/lib/postgresql/data")
        self.assertEqual(s.get("pg1-socket-path"), "/var/run/postgresql")

    def test_repo1_local_posix(self):
        self.assertEqual(self.g.get("repo1-type"), "posix")
        self.assertEqual(self.g.get("repo1-path"), "/var/lib/pgbackrest")
        self.assertEqual(self.g.get("repo1-retention-full-type"), "count")
        self.assertEqual(self.g.get("repo1-retention-full"), "2")

    def test_repo2_sftp_to_dr1_pinned_hostkey(self):
        g = self.g
        self.assertEqual(g.get("repo2-type"), "sftp")
        self.assertEqual(g.get("repo2-sftp-host"), WG["dr-1"], "repo2 must point at dr-1's wg IP (never a public name)")
        self.assertEqual(g.get("repo2-sftp-host-port"), "2222")
        self.assertEqual(g.get("repo2-sftp-host-user"), "pgbackrest")
        self.assertEqual(g.get("repo2-sftp-host-key-check-type"), "fingerprint",
                         "host key pinned (07-SEC A2: SFTP impersonation)")
        self.assertRegex(g.get("repo2-sftp-host-fingerprint", ""), r"^\S+$", "fingerprint value required")
        self.assertRegex(g.get("repo2-sftp-private-key-file", ""), r"^/run/secrets/pgbackrest/",
                         "private key read from the secrets mount, not a disk path")
        self.assertEqual(g.get("repo2-path"), "/repo")
        self.assertEqual(g.get("repo2-retention-full-type"), "time")
        self.assertEqual(g.get("repo2-retention-full"), "35")

    def test_cipher_aes_256_cbc_on_both_repos(self):  # AC-12.3 "cipher config grep"
        self.assertEqual(self.g.get("repo1-cipher-type"), "aes-256-cbc")
        self.assertEqual(self.g.get("repo2-cipher-type"), "aes-256-cbc")

    def test_no_cipher_pass_in_committed_template(self):  # AC-12.3, 07-SEC AB-7, TRD s9.2 last para
        raw = CONF_J2.read_text(encoding="utf-8")
        for m in re.finditer(r"(?im)^\s*(repo\d-cipher-pass)\s*=\s*(.*)$", raw):
            self.fail("template must not carry %s (rendered into a tmpfs include by the role): %s"
                      % (m.group(1), m.group(0).strip()))
        self.assertRegex(raw, r"/run/(lims/)?secrets/pgbackrest",
                         "template must point at the tmpfs secrets path (config-include-path or key file)")

    def test_async_archive_and_spool(self):
        g = self.g
        self.assertEqual(g.get("archive-async"), "y")
        self.assertEqual(g.get("spool-path"), "/var/spool/pgbackrest")
        self.assertEqual(g.get("archive-push-queue-max"), "20GiB")
        self.assertIn(g.get("compress-type"), ("zst", "lz4", "gz"), "TRD s9.2: zst with fallback to lz4/gz")

    def test_dev_without_dr_still_renders(self):  # dev = one VM, groups['dr'] == []
        out = render(CONF_J2, dr=False)
        self.assertNotRegex(out, r"(?m)^repo2-sftp-host\s*=\s*$", "no empty repo2 host")
        self.assertNotIn("UNDEF_dr", out)
        self.assertEqual(kv(out, "global").get("repo1-cipher-type"), "aes-256-cbc")


# ---------------------------------------------------------------- zz-lims.conf.j2 archive settings (AC-12.1)
class ArchiveSettingsTest(unittest.TestCase):
    def test_archive_command_mode_timeout(self):
        c = kv(render(ZZ_J2))
        self.assertEqual(c.get("archive_mode"), "on")
        self.assertEqual(c.get("archive_timeout").strip("'\""), "60s")
        cmd = c.get("archive_command", "").strip("'\"")
        self.assertEqual(cmd, "pgbackrest --stanza=lims archive-push %p", "TRD s7.7 verbatim")


# ---------------------------------------------------------------- role: timers, tmpfs secrets, host scope (TRD s9.3)
class RoleTest(unittest.TestCase):
    def setUp(self):
        self.files = role_text()
        self.all = "\n".join(self.files.values())
        self.cal = re.findall(r"(?im)^\s*OnCalendar\s*=\s*(.+?)\s*$", self.all)

    def test_tasks_parse(self):
        t = [k for k in self.files if k.startswith("tasks/") and k.endswith((".yml", ".yaml"))]
        self.assertTrue(t, "role needs tasks/*.yml")
        for k in t:
            yaml.safe_load(self.files[k])

    def test_full_backup_saturday_0130_npt(self):  # Fri 19:45 UTC
        self.assertTrue(any(re.search(r"\bFri\b", c) and re.search(r"\b19:45", c) for c in self.cal), self.cal)

    def test_incremental_other_days_0130_npt(self):
        inc = [c for c in self.cal if re.search(r"\b19:45", c)
               and not re.fullmatch(r"\s*Fri\s+\*-\*-\*\s+19:45(:00)?\s*", c)]
        self.assertTrue(inc, "need an OnCalendar for the other six days at 19:45 UTC (01:30 NPT): %s" % self.cal)

    def test_check_every_15_min(self):
        self.assertTrue(any(re.search(r"\*:0?/15|\*:00/15|\*:0,15,30,45|\*:00,15,30,45|\*-\*-\* \*:0/15", c)
                            or c.strip() in ("*:0/15", "*:00/15") for c in self.cal) or
                        any(re.search(r"OnUnitActiveSec\s*=\s*15\s*(min|m)\b", v) for v in self.files.values()),
                        "archive check timer every 15 min: %s" % self.cal)
        self.assertRegex(self.all, r"pgbackrest\s+--stanza=lims\s+check|--stanza=lims\s+check|check\b.*--stanza")

    def test_verify_sunday_0330_npt(self):  # Sat 21:45 UTC
        self.assertTrue(any(re.search(r"\bSat\b", c) and re.search(r"\b21:45", c) for c in self.cal), self.cal)
        self.assertIn("verify", self.all)

    def test_metrics_every_minute(self):
        self.assertTrue(any(re.fullmatch(r"\*:\*|\*:0/1|\*-\*-\* \*:\*:00|minutely", c.strip()) for c in self.cal)
                        or re.search(r"OnUnitActiveSec\s*=\s*(1\s*min|60\s*s|1m)\b", self.all),
                        "metrics timer every minute: %s" % self.cal)
        self.assertIn("pgbackrest_metrics.sh", self.all)

    def test_backups_both_repos(self):
        self.assertRegex(self.all, r"--type=full")
        self.assertRegex(self.all, r"--type=incr")
        self.assertRegex(self.all, r"--repo=1")
        self.assertRegex(self.all, r"--repo=2")

    def test_cipher_pass_only_on_tmpfs_of_data_hosts(self):  # AC-12.3
        self.assertIn("tmpfs", self.all.lower(), "role must render the pass onto tmpfs")
        self.assertRegex(self.all, r"/run/lims/secrets/pgbackrest")
        for k, v in self.files.items():  # never under a disk path
            for m in re.finditer(r"(?im)^.*(cipher[-_]pass|repo[12]_cipher).*dest\s*:\s*(\S+)", v):
                self.assertTrue(m.group(2).strip("'\"").startswith("/run/"), "%s: pass written to disk: %s" % (k, m.group(0)))
        self.assertNotRegex(self.all, r"(?im)^\s*repo\d-cipher-pass\s*=\s*[A-Za-z0-9+/=]{12,}\s*$", "literal pass")

    def test_role_applied_only_to_data_group(self):  # dr-1 never holds a cipher pass
        plays = []
        for pb in sorted(PLAYBOOKS.glob("*.y*ml")) if PLAYBOOKS.is_dir() else []:
            doc = yaml.safe_load(pb.read_text(encoding="utf-8")) or []
            for p in doc if isinstance(doc, list) else []:
                roles = [r if isinstance(r, str) else (r.get("role") or r.get("name")) for r in p.get("roles", [])]
                if "pgbackrest" in roles:
                    plays.append((pb.name, p.get("hosts")))
        self.assertTrue(plays, "no play in infra/ansible/playbooks applies role pgbackrest")
        for name, hosts in plays:
            self.assertEqual(str(hosts).strip(), "data", "%s: pgbackrest must run on `data` only, got %r" % (name, hosts))


# ---------------------------------------------------------------- secrets schema (AC-12.3)
class SecretsSchemaTest(unittest.TestCase):
    def _entries(self, path):
        found = []

        def walk(x):
            if isinstance(x, dict):
                if "id" in x and "consumers" in x:
                    found.append(x)
                for v in x.values():
                    walk(v)
            elif isinstance(x, list):
                for v in x:
                    walk(v)
        walk(yaml.safe_load(path.read_text(encoding="utf-8")))
        return {e["id"]: e for e in found}

    def test_dr1_is_not_a_consumer_of_any_cipher_pass(self):
        for env in ("dev", "staging", "prod"):
            ents = self._entries(SCHEMAS / ("%s.secrets.schema.yaml" % env))
            for sid in ("pgbackrest_repo1_cipher_pass", "pgbackrest_repo2_cipher_pass"):
                self.assertIn(sid, ents, "%s: missing %s" % (env, sid))
                cons = " ".join(str(c) for c in ents[sid]["consumers"]).lower()
                self.assertNotIn("dr-1", cons, "%s/%s: dr-1 must never hold a cipher pass (AC-12.3)" % (env, sid))
            self.assertNotIn("repo1", " ".join(str(c) for c in ents["pgbackrest_repo2_cipher_pass"]["consumers"]).lower())


# ---------------------------------------------------------------- pgbackrest_metrics.sh behaviour with fakes
def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


FAKE_PGBACKREST = r"""#!/usr/bin/env bash
echo "$*" >> "$FIX/calls.log"
case " $* " in
  *" info"*) [ -f "$FIX/info_fail" ] && exit 1; cat "$FIX/info.json"; exit 0;;
  *" repo-ls"*) case " $* " in *"--repo=2"*|*"--repo 2"*) cat "$FIX/repo2-ls.json";; *) cat "$FIX/repo1-ls.json";; esac; exit 0;;
  *" check"*) exit "${FAKE_CHECK_RC:-0}";;
esac
exit 0
"""
FAKE_PSQL = r"""#!/usr/bin/env bash
q="$*"
echo "$q" >> "$FIX/psql.log"
if [[ "$q" == *pg_wal_lsn_diff* ]]; then echo "${FAKE_LSN_DIFF:-0}"
elif [[ "$q" == *last_archived_wal* ]]; then echo "000000010000000000000042"
else echo 0; fi
"""
SEG = "000000010000000000000042"


def _backup(label, typ, repo, start, stop):
    return {"label": label, "type": typ, "timestamp": {"start": start, "stop": stop},
            "database": {"id": 1, "repo-key": repo}, "info": {"size": 1, "repository": {"size": 1}}}


class MetricsScriptTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(METRICS.is_file(), "missing infra/monitoring/textfile/pgbackrest_metrics.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t09-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.out = self.tmp / "out"
        self.bin.mkdir()
        self.out.mkdir()
        for n, body in (("pgbackrest", FAKE_PGBACKREST), ("psql", FAKE_PSQL)):
            (self.bin / n).write_bytes(body.replace("\r\n", "\n").encode())
        self.now = int(time.time())

    def run_script(self, backups, repo1_age=10, repo2_age=120, lsn_diff=0, info_fail=False, extra_env=None):
        n = self.now
        info = [{"name": "lims", "status": {"code": 0, "message": "ok"},
                 "cipher": "aes-256-cbc",
                 "repo": [{"key": 1, "cipher": "aes-256-cbc", "status": {"code": 0, "message": "ok"}},
                          {"key": 2, "cipher": "aes-256-cbc", "status": {"code": 0, "message": "ok"}}],
                 "archive": [{"id": "17-1", "min": "000000010000000000000001", "max": SEG,
                              "database": {"id": 1, "repo-key": 1}},
                             {"id": "17-1", "min": "000000010000000000000001", "max": SEG,
                              "database": {"id": 1, "repo-key": 2}}],
                 "backup": backups}]
        (self.tmp / "info.json").write_text(json.dumps(info))
        # repo-ls: newest entry is the max segment; older ones must not win
        for r, age in (("repo1", repo1_age), ("repo2", repo2_age)):
            (self.tmp / ("%s-ls.json" % r)).write_text(json.dumps({
                SEG + "-" + "a" * 40 + ".zst": {"type": "file", "size": 100, "time": n - age},
                "000000010000000000000041-" + "b" * 40 + ".zst": {"type": "file", "size": 100, "time": n - age - 60},
                "000000010000000000000040-" + "c" * 40 + ".zst": {"type": "file", "size": 100, "time": n - age - 120}}))
        if info_fail:
            (self.tmp / "info_fail").write_text("1")
        env = dict(os.environ, FIX=self.tmp.as_posix(), FAKE_LSN_DIFF=str(lsn_diff), TEXTFILE_DIR=self.out.as_posix(),
                   PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        env.update(extra_env or {})
        r = subprocess.run([_bash(), "-c", "cd '%s' && bash '%s'" % (ROOT.as_posix(), METRICS.as_posix())],
                           env=env, capture_output=True, text=True, timeout=60)
        text = r.stdout + "".join(p.read_text() for p in self.out.glob("*.prom"))
        return r, text

    @staticmethod
    def metric(text, name):
        return [(m.group(1) or "", float(m.group(2))) for m in
                re.finditer(r"(?m)^%s(\{[^}]*\})?\s+([0-9.eE+-]+)\s*$" % re.escape(name), text)]

    def good_backups(self):
        n = self.now
        return [_backup("20260101-000000F", "full", 1, n - 900000, n - 899000),
                _backup("20260108-000000F", "full", 1, n - 300000, n - 299000),
                _backup("20260109-000000F_20260110-000000I", "incr", 1, n - 40000, n - 39900),
                _backup("20260108-000100F", "full", 2, n - 299000, n - 298000),
                _backup("20260109-000100F_20260110-000100I", "incr", 2, n - 39000, n - 38500)]

    def test_exit_zero_and_three_wal_metrics_exported(self):
        r, t = self.run_script(self.good_backups())
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        for name in ("lims_ops_wal_repo2_newest_age_seconds", "lims_ops_wal_unarchived_bytes",
                     "lims_ops_wal_check_consecutive_failures"):
            self.assertTrue(self.metric(t, name), "metric not exported: " + name)

    def test_repo2_age_from_repo_ls_of_repo2(self):  # AC-12.2: not repo1, not check time
        _, t = self.run_script(self.good_backups(), repo1_age=5, repo2_age=500)
        v = self.metric(t, "lims_ops_wal_repo2_newest_age_seconds")[0][1]
        self.assertTrue(480 <= v <= 540, "expected ~500 s from repo2 listing, got %s" % v)

    def test_repo2_age_healthy_and_calls_use_documented_commands(self):
        _, t = self.run_script(self.good_backups(), repo2_age=120)
        v = self.metric(t, "lims_ops_wal_repo2_newest_age_seconds")[0][1]
        self.assertTrue(110 <= v <= 170, v)
        calls = (self.tmp / "calls.log").read_text()
        self.assertRegex(calls, r"info\b.*--output[= ]json|--output[= ]json.*\binfo\b")
        self.assertRegex(calls, r"repo-ls\b.*--repo[= ]2|--repo[= ]2.*\brepo-ls\b")

    def test_unarchived_bytes_idle_and_busy(self):  # age alerts gate on this (TRD s9.4)
        _, t0 = self.run_script(self.good_backups(), lsn_diff=0)
        self.assertEqual(self.metric(t0, "lims_ops_wal_unarchived_bytes")[0][1], 0)
        _, t1 = self.run_script(self.good_backups(), lsn_diff=33554432)
        self.assertEqual(self.metric(t1, "lims_ops_wal_unarchived_bytes")[0][1], 33554432)
        q = (self.tmp / "psql.log").read_text()
        for needle in ("pg_wal_lsn_diff", "pg_current_wal_lsn", "last_archived_wal"):
            self.assertIn(needle, q, "script must use " + needle)

    def test_backup_last_success_timestamp_per_repo_and_type(self):  # AC-12.4 "backup timestamp"
        n = self.now
        _, t = self.run_script(self.good_backups())
        got = {}
        for lab, val in self.metric(t, "lims_ops_backup_last_success_timestamp_seconds"):
            repo = re.search(r'repo="(?:repo)?(\d)"', lab)
            typ = re.search(r'type="(\w+)"', lab)
            self.assertTrue(repo and typ, "labels repo and type required: " + lab)
            got[(repo.group(1), typ.group(1))] = val
        want = {("1", "full"): n - 299000, ("1", "incr"): n - 39900, ("2", "full"): n - 298000, ("2", "incr"): n - 38500}
        for k, v in want.items():
            self.assertIn(k, got, "missing series %s" % (k,))
            self.assertEqual(got[k], v, "newest stop time per (repo,type) for %s" % (k,))
        self.assertTrue(self.metric(t, "lims_ops_backup_duration_seconds"), "backup_duration_seconds exported (TRD s11)")

    def test_info_failure_never_reads_as_healthy(self):  # adversarial: pgbackrest down must not look like age 0
        r, t = self.run_script(self.good_backups(), info_fail=True)
        age = self.metric(t, "lims_ops_wal_repo2_newest_age_seconds")
        self.assertTrue(r.returncode != 0 or not age or age[0][1] >= 900,
                        "info failure produced a fresh-looking age: rc=%s age=%s" % (r.returncode, age))

    def test_no_secret_in_output_or_script(self):
        sec = "S3cr3tPassphraseXYZ"
        _, t = self.run_script(self.good_backups(), extra_env={"PGBACKREST_REPO1_CIPHER_PASS": sec,
                                                                "PGBACKREST_REPO2_CIPHER_PASS": sec})
        self.assertNotIn(sec, t)
        self.assertNotRegex(METRICS.read_text(encoding="utf-8"), r"(?i)cipher[-_]pass\s*=\s*\S+")


# ---------------------------------------------------------------- check wrapper: counter behind WalArchiveFailing (AC-12.2)
class CheckCounterTest(unittest.TestCase):
    """Contract: lims-pgbackrest-check.sh honours $STATE_DIR (default /var/lib/lims/pgbackrest) and $PGBACKREST."""
    SCRIPT = ROLE / "files" / "lims-pgbackrest-check.sh"

    def test_counter_increments_on_failure_and_resets_on_ok(self):
        self.assertTrue(self.SCRIPT.is_file(), "missing " + str(self.SCRIPT))
        tmp = Path(tempfile.mkdtemp(prefix="t09chk-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        fake = tmp / "pgbackrest"
        fake.write_bytes(b'#!/bin/sh\n[ "$(cat "$FIX/mode")" = ok ]\n')
        state = tmp / "state"
        state.mkdir()
        env = dict(os.environ, FIX=tmp.as_posix(), STATE_DIR=state.as_posix(), PGBACKREST=fake.as_posix())
        got = []
        for mode in ("fail", "fail", "ok"):
            (tmp / "mode").write_text(mode)
            r = subprocess.run([_bash(), self.SCRIPT.as_posix()], env=env, capture_output=True, text=True, timeout=60)
            got.append((r.returncode, (state / "check_consecutive_failures").read_text().strip()))
        self.assertEqual(got, [(1, "1"), (1, "2"), (0, "0")], got)


# ---------------------------------------------------------------- DECISION.md (done_when: decision, multi-repo, WAL/day)
class DecisionTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(DECISION.is_file(), "missing infra/compose/supabase/DECISION.md")
        self.t = DECISION.read_text(encoding="utf-8")
        i = self.t.find("T-09")
        self.assertGreaterEqual(i, 0, "DECISION.md needs a T-09 section")
        self.sec = self.t[i:]

    def test_records_pgbackrest_or_walg(self):
        self.assertRegex(self.sec, r"(?im)^\s*(Decision|Outcome)\s*:\s*(pgBackRest|WAL-G)\b",
                         "line `Decision: pgBackRest` or `Decision: WAL-G` in the T-09 section")

    def test_records_multi_repo_failure_behaviour(self):  # 03-APP-FLOW s3.3, re-verified vs pgbackrest.org for 2.60
        self.assertNotRegex(self.sec, r"(?i)\bNOT (yet run|measured|run)\b|still OPEN", "T-09 section says the work is not done")
        for needle in ("2.60", "pgbackrest.org", "archive-push", "repo1", "repo2"):
            self.assertIn(needle, self.sec, "multi-repo failure note must mention " + needle)
        self.assertRegex(self.sec, r"(?i)(error|fail).{0,200}(retr|keep)|(retr|keep).{0,200}(error|fail)")

    @unittest.skip("needs data-1/dr-1 hosts (B12)")  # LD-34 / LD-43: measured WAL GiB/day deferred
    def test_records_wal_per_day_measured(self):  # R8
        self.assertNotRegex(self.sec, r"(?i)\bNOT (yet run|measured|run)\b|still OPEN", "T-09 section says the work is not done")
        self.assertRegex(self.sec, r"(?i)\b\d+(\.\d+)?\s*(KiB|MiB|GiB|MB|GB)\s*(/|per)\s*day")
        self.assertRegex(self.sec, r"(?im)^WAL volume per day \(measured[^)]*\):\s*\d+(\.\d+)?\s*(MiB|GiB)/day",
                         "needs a line `WAL volume per day (measured ...): <n> MiB|GiB/day`")
        self.assertRegex(self.sec, r"(?i)R8|compress")

    def test_check_ok_both_repos_and_full_incr_recorded(self):
        self.assertNotRegex(self.sec, r"(?i)\bNOT (yet run|measured|run)\b|still OPEN", "T-09 section says the work is not done")
        self.assertRegex(self.sec, r"(?i)check")
        self.assertRegex(self.sec, r"(?i)full")
        self.assertRegex(self.sec, r"(?i)incr")


if __name__ == "__main__":
    unittest.main()
