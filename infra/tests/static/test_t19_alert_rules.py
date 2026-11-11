"""T-19 tests (tester role): C1 alert rules, promtool test files, dashboards D1-D11/D13/D14, edge_metrics.sh.

Covers 02-TRD s11.3 (alert catalogue + lint paragraph), s9.4 (RPO arithmetic), 04-UI-UX s3 (dashboards), AC-02.3,
AC-04.7, AC-11.3, AC-12.2, AC-13.2 (rule side), AC-16.1, AC-22.3, AC-28.2, 07-SECURITY (no PHI on dashboards/labels).
Binding decisions: LD-39 (the tester owns every rules/tests/*.test.yml; the writer only writes rule files),
LD-45 (lean/full profiles: nothing here hard-codes a host count; prod-1 is a site-A host in `lean`).
Done when (T-19): every 02-TRD s11.3 rule exists with a runbook link; tests cover firing/not firing incl. the
idle-database RpoAtRisk case.

CONTRACTS where the spec is silent (the writer must meet them; a disagreement is a dispute, not a silent change):
 * Files: ops, edge, db, backup, host, security, audit, runtime `.rules.yml` under infra/monitoring/rules/ hold the
   alerts of CAT below (supersets allowed). TargetDown/Watchdog stay in ops (T-18). BridgeAgent* are T-20's.
 * runbook_url = infra/runbooks/<file>.md#<alertname lower-case>; <file> = edge for edge rules and LimsAuthJailBan,
   db, audit, runtime for those families, backup|drill for backup rules, anything for ops/host/security.
 * Labels: severity in {page,warn,info}, team=ops; severity is the only extra static label, except
   LimsAuthJailBan notify_tenant="false" (02-TRD s11.3). Repeated alert names only for the warn/page tiers of
   RestoreDrillOverdue and ObjectReplicaStale.
 * `for`: the value in CAT when the spec names one; otherwise <= 5 m for page, <= 15 m for warn/info, <= 2 m for
   counter-increase alerts (an alert that must fire the minute a counter moves).
 * Metric names the spec does not give are pinned in the header comment of each rules/tests/*.test.yml.
 * edge_metrics.sh: bash, LF endings, reads VictoriaLogs through `curl` (VL_URL optional), asks for status 404
   over the last 5m, counts lines per remote_addr itself, writes $TEXTFILE_DIR/edge.prom atomically with exactly
   `lims_ops_edge_not_found_max_per_ip_5m <n>` (no labels, never an IP); when VictoriaLogs cannot be read it exits
   non-zero and leaves NO sample of that metric (no healthy 0, no stale value).
 * Dashboards: infra/monitoring/grafana/dashboards/D<n>-*.json, one per n in 1-11, 13, 14 (D12 is T-20, D15 is
   T-21), Prometheus datasource only, timezone Asia/Kathmandu, unique uid, no literal host selectors (profile
   independent: use the `host` label/variable), no PHI-class label names.
Stdlib + PyYAML. Missing file = FAIL. `promtool` runs only when on PATH (hard FAIL if CI=true and absent).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t19_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml

from test_t18_monitoring import DROP_LABELS, MON, ROOT, _secs

RULES = MON / "rules"
PTESTS = RULES / "tests"
DASH = MON / "grafana" / "dashboards"
EDGE_SH = MON / "textfile" / "edge_metrics.sh"
P, W, I = "page", "warn", "info"

# family -> alert -> (severities, exact `for` in seconds or None = capped by severity)
CAT = {
    "ops": {"Watchdog": (("none",), None), "TargetDown": (None, 120), "MetricCardinalityHigh": ((W,), None)},
    "edge": {
        "TLSCertExpiringSoon": ((W,), None), "TLSCertExpiryCritical": ((P,), None), "Edge5xxRate": ((P,), None),
        "RateLimitSpike": ((W,), 600), "ForbiddenPortOpen": ((P,), None), "Fail2banBanSpike": ((W,), None),
        "EdgeNotFoundSpike": ((W,), 900), "EgressDenied": ((W,), None)},
    "db": {
        "PostgresDown": ((P,), None), "PostgresConnectionsHigh": ((W,), None), "PostgresDeadlocks": ((W,), None),
        "LongRunningTx": ((W,), None), "PgBouncerWaiting": ((W,), 120), "ReplicationSlotWalRetained": ((P,), None),
        "PostgresInvalidIndex": ((P,), 300)},
    "backup": {
        "WalArchiveLagging": ((W,), None), "RpoAtRisk": ((P,), None), "WalArchiveFailing": ((P,), None),
        "NoOffsiteArchive": ((P,), 300), "BackupMissed": ((P,), None), "RestoreDrillOverdue": ((W, P), None),
        "RestoreDrillFailed": ((P,), None), "StandbyLagHigh": ((W,), 600), "ObjectReplicaStale": ((W, P), None)},
    "host": {
        "DiskFillForecast": ((P,), None), "StorageVolumeForecastFull": ((W,), None), "ClockSkew": ((W,), 300),
        "HostMemoryPressure": ((W,), 600), "PatchOverdue": ((W,), None), "ConfigDrift": ((W,), None),
        "SiteADown": ((P,), 300)},
    "security": {
        "SshLoginOutsideOps": ((P,), None), "SudoByUnknown": ((P,), None), "SecretDecryptUnexpected": ((P,), None),
        "LimsAuthJailBan": ((P,), None)},
    "audit": {
        "AuditShippingLagging": ((P,), None), "AuditShippingDown": ((P,), None), "AuditDigestMismatch": ((P,), None),
        "AuditShippingDisabled": ((W,), None)},
    "runtime": {
        "WorkerDown": ((P,), 120), "QueueBacklog": ((W,), 600), "RendererRestarting": ((W,), None),
        "ScannerDown": ((P,), None), "ScannerSignaturesStale": ((W,), None), "StudioEnabled": ((I,), None),
        "ValkeyDown": ((P,), 60), "DeployRolledBack": ((P,), None)},
}
ALL = {a: fam for fam, d in CAT.items() for a in d}
INCR = {"EgressDenied", "DeployRolledBack", "LimsAuthJailBan", "SshLoginOutsideOps", "SudoByUnknown",
        "SecretDecryptUnexpected", "AuditDigestMismatch", "PostgresDeadlocks"}
CAP = {P: 300, W: 900, I: 900}
TWO_TIER = {"RestoreDrillOverdue", "ObjectReplicaStale"}
RUNBOOK_FILES = {"edge": {"edge"}, "db": {"db"}, "backup": {"backup", "drill"}, "audit": {"audit"}, "runtime": {"runtime"}}
# alerts that have no `for` boundary case because their series are minutes long (still covered fire/not-fire)
NO_BOUNDARY = {"RateLimitSpike"}
T19_TEST_FILES = ["ops", "host", "host_slow", "edge", "edge_ratelimit", "db", "backup", "backup_slow", "audit",
                  "security", "runtime"]


def _n(s):
    return re.sub(r"\s+", "", str(s))


def _load(fam):
    p = RULES / ("%s.rules.yml" % fam)
    assert p.exists(), "missing infra/monitoring/rules/%s.rules.yml" % fam
    d = yaml.safe_load(p.read_text(encoding="utf-8"))
    alerts, records = {}, []
    for g in d["groups"]:
        for r in g["rules"]:
            if "alert" in r:
                alerts.setdefault(r["alert"], []).append(r)
            else:
                records.append(r)
    return alerts, records


def _for_s(r):
    f = str(r.get("for", "0s"))
    return 0 if f in ("0", "0m", "0s") else _secs(f)


def _all_case_files():
    return sorted(PTESTS.glob("*.test.yml")) if PTESTS.exists() else []


def _load_cases():
    out = []
    for f in _all_case_files():
        if f.name == "instruments.test.yml":  # T-20's file
            continue
        doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        for c in doc.get("tests", []):
            out.append((f, doc, c))
    return out


# ================================================================ rule catalogue
class RuleCatalogueTest(unittest.TestCase):
    def test_every_trd_s11_3_alert_exists_in_its_file(self):  # done_when
        for fam, alerts in CAT.items():
            have, _ = _load(fam)
            for name in alerts:
                self.assertIn(name, have, "%s.rules.yml lacks %s" % (fam, name))

    def test_severity_and_for(self):  # 02-TRD s11.3 table; AC-02.3, AC-11.3, AC-22.3
        for fam, alerts in CAT.items():
            have, _ = _load(fam)
            for name, (sevs, f) in alerts.items():
                rules = have[name]
                if sevs is not None:
                    self.assertEqual(sorted(r["labels"]["severity"] for r in rules), sorted(sevs), name)
                for r in rules:
                    sev = r["labels"]["severity"]
                    got = _for_s(r)
                    if f is not None:
                        self.assertEqual(got, f, "%s: for" % name)
                    elif name in INCR:
                        self.assertLessEqual(got, 120, "%s: counter alert must fire within 2 min" % name)
                    elif sev in CAP:
                        self.assertLessEqual(got, CAP[sev], "%s (%s): `for` too long" % (name, sev))

    def test_repeated_names_only_for_two_tier_alerts(self):
        seen = {}
        paths = [RULES / ("%s.rules.yml" % f) for f in list(CAT) + ["instruments"]]
        self.assertTrue(all(p.exists() for p in paths), "missing rule file(s)")
        for p in paths:
            d = yaml.safe_load(p.read_text(encoding="utf-8"))
            for g in d["groups"]:
                for r in g["rules"]:
                    if "alert" in r:
                        seen.setdefault(r["alert"], []).append((p.name, (r.get("labels") or {}).get("severity")))
        for name, v in seen.items():
            if len(v) > 1:
                self.assertIn(name, TWO_TIER, "alert %s defined more than once: %s" % (name, v))
                self.assertEqual(sorted(s for _, s in v), [P, W], name)

    def test_lint_summary_runbook_team_no_phi(self):  # 02-TRD s11.3 last paragraph, 07-SECURITY
        for fam in CAT:
            have, _ = _load(fam)
            for name, rules in have.items():
                for r in rules:
                    a = r.get("annotations") or {}
                    self.assertTrue(a.get("summary"), "%s: annotations.summary" % name)
                    m = re.fullmatch(r"infra/runbooks/([a-z0-9_-]+)\.md#([a-z0-9_-]+)", str(a.get("runbook_url", "")))
                    self.assertTrue(m, "%s: runbook_url %r" % (name, a.get("runbook_url")))
                    self.assertEqual(m.group(2), name.lower(), "%s: anchor" % name)
                    want = {"edge"} if name == "LimsAuthJailBan" else RUNBOOK_FILES.get(fam)
                    if want:
                        self.assertIn(m.group(1), want, "%s: runbook file" % name)
                    self.assertEqual((r.get("labels") or {}).get("team"), "ops", "%s: team" % name)
                    sev = r["labels"]["severity"]
                    self.assertTrue(sev in (P, W, I, "none") or "{{" in sev, "%s: severity %r" % (name, sev))
                    blob = json.dumps(r)
                    for lbl in DROP_LABELS:
                        self.assertNotRegex(blob, r"\b%s\b" % lbl, "%s mentions PHI-class label %s" % (name, lbl))
                    self.assertNotRegex(blob, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}", "%s embeds an address" % name)
                    extra = set(r["labels"]) - {"severity", "team", "notify_tenant"}
                    self.assertFalse(extra, "%s: unexpected static labels %s" % (name, sorted(extra)))

    def test_only_lims_auth_jail_ban_sets_notify_tenant_and_to_false(self):  # 02-TRD s11.3 :881
        for fam in CAT:
            have, _ = _load(fam)
            for name, rules in have.items():
                for r in rules:
                    v = r["labels"].get("notify_tenant")
                    if name == "LimsAuthJailBan":
                        self.assertEqual(v, "false")
                    else:
                        self.assertNotEqual(v, "true", "%s: tenant mail is for BridgeAgentOfflineLong only" % name)

    def test_target_down_pages_site_a_hosts_of_both_profiles(self):  # LD-45
        r = _load("ops")[0]["TargetDown"][0]
        sev = str(r["labels"]["severity"])
        self.assertIn("{{", sev, "TargetDown severity must be derived from the host label")
        m = re.search(r'match\s+"([^"]+)"', sev)
        self.assertTrue(m, "no `match` on the host label in the severity template")
        for host in ("data-1", "app-1", "prod-1"):
            self.assertTrue(re.search(m.group(1), host), "%s must page (site A)" % host)
        for host in ("dr-1", "ops-1", "backup-1"):
            self.assertFalse(re.search(m.group(1), host), "%s must only warn (site B)" % host)

    def test_recording_rule_and_cardinality_alert(self):  # 02-TRD s11.2 item 2
        alerts, records = _load("ops")
        rec = [r for r in records if r["record"] == "lims_ops_series_per_metric"]
        self.assertEqual(len(rec), 1, "recording rule lims_ops_series_per_metric")
        self.assertIn("__name__", rec[0]["expr"])
        self.assertIn("metric", rec[0]["expr"])
        e = _n(alerts["MetricCardinalityHigh"][0]["expr"])
        self.assertIn("lims_ops_series_per_metric", e)
        self.assertIn(">5000", e)

    def test_wal_alerts_follow_9_4_arithmetic(self):  # AC-12.2, 08 A25 D-205
        a, _ = _load("backup")
        lag, rpo, fail = (_n(a[x][0]["expr"]) for x in ("WalArchiveLagging", "RpoAtRisk", "WalArchiveFailing"))
        for e, limit in ((lag, "600"), (rpo, "840")):
            self.assertIn("lims_ops_wal_repo2_newest_age_seconds>" + limit, e)
            self.assertIn("lims_ops_wal_unarchived_bytes>0", e, "idle database must not alert")
        self.assertRegex(fail, r"lims_ops_wal_check_consecutive_failures>=2")
        self.assertNotIn("RpoBreached", a)  # 02-TRD s9.4: no RpoBreached alert and no 1200 s threshold
        for rules in a.values():
            for r in rules:
                self.assertNotRegex(_n(r["expr"]), r"\b1200\b")

    def test_offsite_failed_drill_and_edge_not_found_expressions(self):
        b, _ = _load("backup")
        self.assertRegex(_n(b["NoOffsiteArchive"][0]["expr"]), r"lims_ops_offsite_archive_configured==0")
        self.assertRegex(_n(b["RestoreDrillFailed"][0]["expr"]), r"lims_ops_restore_drill_checks_failed>0")
        e, _ = _load("edge")
        x = _n(e["EdgeNotFoundSpike"][0]["expr"])
        self.assertRegex(x, r"lims_ops_edge_not_found_max_per_ip_5m>30")
        r = e["EdgeNotFoundSpike"][0]
        self.assertNotRegex(json.dumps([r["expr"], r["labels"]]).lower(), r"fail2ban|ban", "404s never ban (D-211)")

    def test_threshold_constants(self):  # AC-02.3, AC-16.1, AC-28.2, 02-TRD s11.3
        def has(expr, *alts):
            return any(re.search(a, _n(expr)) for a in alts)

        e, _ = _load("edge")
        self.assertTrue(has(e["TLSCertExpiringSoon"][0]["expr"], r"21\*86400", r"1814400", r"21\*24\*3600"))
        self.assertTrue(has(e["TLSCertExpiryCritical"][0]["expr"], r"7\*86400", r"604800", r"7\*24\*3600"))
        h, _ = _load("host")
        self.assertTrue(has(h["PatchOverdue"][0]["expr"], r"35\*86400", r"3024000", r"35\*24\*3600"))
        self.assertIn("lims_ops_last_patch_timestamp_seconds", _n(h["PatchOverdue"][0]["expr"]))
        self.assertIn("/srv/lims/storage", h["StorageVolumeForecastFull"][0]["expr"])
        self.assertTrue(has(h["StorageVolumeForecastFull"][0]["expr"], r"90\*86400", r"7776000"))
        self.assertTrue(has(h["DiskFillForecast"][0]["expr"], r"\[6h\]"))
        r, _ = _load("runtime")
        self.assertTrue(has(r["ScannerSignaturesStale"][0]["expr"], r"3\*86400", r"259200", r"3\*24\*3600"))
        b, _ = _load("backup")
        self.assertTrue(has(b["BackupMissed"][0]["expr"], r"26\*3600", r"93600", r"26\*60\*60", r"26\*86400/24"))
        tiers = {x["labels"]["severity"]: _n(x["expr"]) for x in b["ObjectReplicaStale"]}
        self.assertRegex(tiers[W], r"3600|1h")
        self.assertIn("1800", tiers[W])
        self.assertRegex(tiers[P], r"10800|3\*3600")

    def test_valkey_down_summary_and_runbook(self):  # AC-11.3, 02-TRD s11.3 :878
        v = _load("runtime")[0]["ValkeyDown"][0]
        self.assertEqual(v["labels"]["severity"], P)
        s = v["annotations"]["summary"].lower()
        self.assertIn("rate-limit backend down", s)
        self.assertIn("fail closed", s)
        self.assertEqual(v["annotations"]["runbook_url"], "infra/runbooks/runtime.md#valkeydown")
        self.assertRegex(_n(v["expr"]), r'up\{service="valkey"\}==0')

    def test_worker_and_scanner_use_scrape_labels(self):
        r, _ = _load("runtime")
        self.assertRegex(_n(r["WorkerDown"][0]["expr"]), r'up\{service=~"worker\.\*"\}==0')

    @unittest.skipUnless(shutil.which("promtool"), "promtool not on PATH (CI: promtool check rules)")
    def test_promtool_check_rules(self):
        files = [str(RULES / ("%s.rules.yml" % f)) for f in CAT]
        r = subprocess.run(["promtool", "check", "rules"] + files, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_promtool_present_in_ci(self):
        if os.environ.get("CI") == "true":
            self.assertTrue(shutil.which("promtool"), "promtool missing in CI")


# ================================================================ promtool unit-test files (LD-39)
class PromtoolFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        missing = [n for n in T19_TEST_FILES if not (PTESTS / ("%s.test.yml" % n)).exists()]
        assert not missing, "missing rules/tests/%s" % [m + ".test.yml" for m in missing]
        cls.cases = _load_cases()
        cls.expect = [(f, c, e) for f, d, c in cls.cases for e in c.get("alert_rule_test", [])]

    def test_every_rule_file_has_a_test_file_that_loads_it(self):  # LD-39: one per rule file
        for fam in CAT:
            hit = False
            for f in PTESTS.glob(fam + "*.test.yml"):
                doc = yaml.safe_load(f.read_text(encoding="utf-8"))
                if (RULES / ("%s.rules.yml" % fam)).resolve() in [(PTESTS / p).resolve() for p in doc["rule_files"]]:
                    hit = True
            self.assertTrue(hit, "no rules/tests/%s*.test.yml loads %s.rules.yml" % (fam, fam))

    def test_rule_files_exist_and_interval_set(self):
        for f in T19_TEST_FILES:
            doc = yaml.safe_load((PTESTS / ("%s.test.yml" % f)).read_text(encoding="utf-8"))
            self.assertTrue(doc.get("evaluation_interval"), f)
            for p in doc["rule_files"]:
                self.assertTrue((PTESTS / p).resolve().exists(), "%s: %s" % (f, p))

    def test_every_alert_has_firing_and_not_firing_case(self):  # done_when
        for name in ALL:
            es = [e for _, _, e in self.expect if e["alertname"] == name]
            self.assertTrue([e for e in es if e.get("exp_alerts")], "%s: no firing expectation" % name)
            if name != "Watchdog":
                self.assertTrue([e for e in es if not e.get("exp_alerts")], "%s: no not-firing expectation" % name)

    def test_two_tier_alerts_expect_both_severities(self):
        for name in ("ObjectReplicaStale",):
            sev = {a["exp_labels"]["severity"] for _, _, e in self.expect if e["alertname"] == name
                   for a in e.get("exp_alerts") or []}
            self.assertEqual(sev, {W, P}, name)

    def test_for_boundary_cases(self):  # not firing before `for`, firing at/after it
        for fam, alerts in CAT.items():
            for name, (_, f) in alerts.items():
                if not f or name in NO_BOUNDARY:
                    continue
                es = [e for _, _, e in self.expect if e["alertname"] == name]
                before = [e for e in es if not e.get("exp_alerts") and _secs(e["eval_time"]) < f]
                after = [e for e in es if e.get("exp_alerts") and _secs(e["eval_time"]) >= f]
                self.assertTrue(before, "%s: no 'not firing before %ss' case" % (name, f))
                self.assertTrue(after, "%s: no 'firing at/after %ss' case" % (name, f))

    def test_ac_12_2_idle_database_case(self):  # done_when: idle-database RpoAtRisk
        found = 0
        for f, d, c in self.cases:
            ser = {re.match(r"(\w+)", s["series"]).group(1): s["values"] for s in c.get("input_series", [])}
            un, age = ser.get("lims_ops_wal_unarchived_bytes"), ser.get("lims_ops_wal_repo2_newest_age_seconds")
            if un is None or age is None or not re.fullmatch(r"\s*0(\s+0)*\s*|\s*0x\d+\s*", un):
                continue
            if not re.match(r"\s*(\d+)x", age) or int(re.match(r"\s*(\d+)x", age).group(1)) <= 840:
                continue
            names = {e["alertname"]: e for e in c["alert_rule_test"]}
            if "RpoAtRisk" in names and not names["RpoAtRisk"].get("exp_alerts") and \
                    "WalArchiveLagging" in names and not names["WalArchiveLagging"].get("exp_alerts"):
                found += 1
        self.assertGreaterEqual(found, 1, "need an idle case: age > 840 s, unarchived 0, neither alert fires")

    def test_thresholds_are_strict_and_boundary_values_covered(self):  # AC-12.2: 600 / 840 exact are quiet
        blob = (PTESTS / "backup.test.yml").read_text(encoding="utf-8")
        for v in ("600x", "601x", "840x", "841x"):
            self.assertIn(v, blob)

    def test_lean_profile_cases(self):  # LD-45: prod-1 pages (TargetDown, SiteADown, PostgresDown)
        for alert in ("TargetDown", "SiteADown", "PostgresDown"):
            ok = False
            for f, c, e in self.expect:
                if e["alertname"] != alert or not e.get("exp_alerts"):
                    continue
                if "prod-1" in json.dumps(c.get("input_series")):
                    ok = all(a["exp_labels"]["severity"] == P for a in e["exp_alerts"])
            self.assertTrue(ok, "%s: no firing case on the lean host prod-1" % alert)
        full = [c for _, _, c in self.cases if "data-1" in json.dumps(c.get("input_series"))
                and any(e["alertname"] in ("TargetDown", "SiteADown") for e in c["alert_rule_test"])]
        self.assertTrue(full, "full-profile data-1 case missing")

    def test_expected_labels_are_phi_free_and_static_labels_pinned(self):
        for f, c, e in self.expect:
            for a in e.get("exp_alerts") or []:
                self.assertFalse(set(a["exp_labels"]) & set(DROP_LABELS), e["alertname"])
                self.assertEqual(a["exp_labels"].get("team"), "ops", "%s: team" % e["alertname"])

    def test_synthetic_series_only(self):  # CLAUDE.md: synthetic data only
        for n in T19_TEST_FILES:
            blob = (PTESTS / ("%s.test.yml" % n)).read_text(encoding="utf-8")
            self.assertNotRegex(blob, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}", n)
            for lbl in DROP_LABELS:
                self.assertNotRegex(blob, r"\b%s\b" % lbl, "%s: %s" % (n, lbl))
            for ip in re.findall(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", blob):
                self.assertTrue(ip.startswith(("10.", "203.0.113.")), "%s: non-synthetic address %s" % (n, ip))

    def test_alert_names_in_tests_exist(self):
        for _, _, e in self.expect:
            self.assertIn(e["alertname"], ALL, "test refers to unknown alert %s" % e["alertname"])

    def test_promtool_test_rules(self):  # the real check: each file is its own failure
        if not shutil.which("promtool"):
            if os.environ.get("CI") == "true":
                self.fail("promtool missing in CI")
            self.skipTest("promtool not on PATH (CI: promtool test rules)")
        for n in T19_TEST_FILES:
            with self.subTest(n):
                r = subprocess.run(["promtool", "test", "rules", "%s.test.yml" % n], capture_output=True, text=True,
                                   cwd=str(PTESTS))
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


# ================================================================ edge_metrics.sh (AC-04.7)
def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


FAKE_CURL = r"""#!/usr/bin/env bash
echo "$*" >> "$FIX/curl.log"
[ -t 0 ] || cat >> "$FIX/curl.stdin" 2>/dev/null
if [ -f "$FIX/curl_fail" ]; then echo "curl: (22) The requested URL returned error: 500" >&2; exit 22; fi
cat "$FIX/vl_response.jsonl"
"""
METRIC = "lims_ops_edge_not_found_max_per_ip_5m"


def _lines(ip, n, status="404"):
    return "".join(json.dumps({"_time": "2026-11-08T00:00:%02dZ" % (i % 60), "remote_addr": ip, "status": status,
                               "route": "agent"}) + "\n" for i in range(n))


class EdgeMetricsScriptTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(EDGE_SH.is_file(), "missing infra/monitoring/textfile/edge_metrics.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t19-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin, self.out = self.tmp / "bin", self.tmp / "out"
        self.bin.mkdir()
        self.out.mkdir()
        (self.bin / "curl").write_bytes(FAKE_CURL.replace("\r\n", "\n").encode())

    def run_script(self, response="", fail=False, old=None):
        (self.tmp / "vl_response.jsonl").write_text(response, encoding="utf-8")
        if fail:
            (self.tmp / "curl_fail").write_text("1")
        if old is not None:
            (self.out / "edge.prom").write_text(old, encoding="utf-8")
        env = dict(os.environ, FIX=self.tmp.as_posix(), TEXTFILE_DIR=self.out.as_posix(),
                   VL_URL="http://127.0.0.1:9428", PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        # Ruling C1.T-19-ruling: Git Bash's login profile prepends /mingw64/bin (real curl.exe), so put the fake first inside the shell.
        cmd = ("command -v cygpath >/dev/null && B=\"$(cygpath -u '%s')\" || B='%s'; export PATH=\"$B:$PATH\"; "
               "cd '%s' && bash '%s'" % (str(self.bin), self.bin.as_posix(), ROOT.as_posix(), EDGE_SH.as_posix()))
        r = subprocess.run([_bash(), "-c", cmd],
                           env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        f = self.out / "edge.prom"
        return r, (f.read_text(encoding="utf-8") if f.exists() else "")

    @staticmethod
    def samples(text):
        return [l for l in text.splitlines() if l.strip() and not l.startswith("#")]

    def value(self, text):
        m = [re.fullmatch(METRIC + r"\s+([0-9]+(?:\.[0-9]+)?)", l) for l in self.samples(text)]
        self.assertEqual(len([x for x in m if x]), 1, "exactly one %s sample expected: %r" % (METRIC, text))
        return float([x for x in m if x][0].group(1))

    def test_file_shape(self):
        raw = EDGE_SH.read_bytes()
        self.assertTrue(raw.startswith(b"#!/usr/bin/env bash") or raw.startswith(b"#!/bin/bash"))
        self.assertNotIn(b"\r\n", raw, "CRLF breaks bash")
        r = subprocess.run([_bash(), "-n", EDGE_SH.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_max_per_ip_is_exported(self):  # AC-04.7: highest per-IP count
        resp = _lines("203.0.113.7", 31) + _lines("203.0.113.8", 30) + _lines("203.0.113.9", 4)
        r, t = self.run_script(resp)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.value(t), 31)

    def test_no_404s_exports_zero(self):  # a known-quiet edge is 0, not absent
        r, t = self.run_script("")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.value(t), 0)

    def test_ipv6_clients_are_grouped(self):
        r, t = self.run_script(_lines("2001:db8::1", 40) + _lines("203.0.113.7", 5))
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.value(t), 40)

    def test_ip_is_never_a_label_or_value_in_the_output(self):  # 02-TRD s11.3: the IP is never a metric label
        r, t = self.run_script(_lines("203.0.113.7", 12) + _lines("2001:db8::1", 3))
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertNotRegex(t, r"\d+\.\d+\.\d+\.\d+")
        self.assertNotIn("2001:db8", t)
        self.assertNotIn("{", t)
        self.assertEqual(len(self.samples(t)), 1)

    def test_garbage_and_injection_lines_cannot_change_the_metric(self):  # trust boundary: log content
        evil = json.dumps({"remote_addr": '203.0.113.77"} 999 #', "status": "404"}) + "\n"
        resp = "not json at all\n" + '{"_time":"x"}\n' + evil + _lines("203.0.113.7", 10) + "\n\n"
        r, t = self.run_script(resp)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.value(t), 10)
        self.assertNotIn("999", t)
        self.assertEqual(len(self.samples(t)), 1)

    def test_query_asks_for_404_over_five_minutes(self):
        self.run_script(_lines("203.0.113.7", 1))
        sent = (self.tmp / "curl.log").read_text(encoding="utf-8")
        if (self.tmp / "curl.stdin").exists():
            sent += (self.tmp / "curl.stdin").read_text(encoding="utf-8")
        self.assertIn("404", sent)
        self.assertIn("5m", sent)

    def test_victorialogs_unreachable_leaves_no_sample_and_no_stale_value(self):  # never a healthy 0
        r, t = self.run_script("", fail=True, old="%s 99\n" % METRIC)
        self.assertNotEqual(r.returncode, 0, "must exit non-zero when the source failed")
        self.assertNotRegex(t, METRIC + r"\s+\d", "stale/healthy value left behind: %r" % t)

    def test_atomic_write_leaves_no_temp_files(self):
        r, t = self.run_script(_lines("203.0.113.7", 2))
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["edge.prom"])

    def test_second_run_replaces_the_value(self):
        self.run_script(_lines("203.0.113.7", 50))
        r, t = self.run_script(_lines("203.0.113.7", 3))
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.value(t), 3)


# ================================================================ dashboards D1-D11, D13, D14 (04-UI-UX s3)
def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


DASHBOARDS = {
    1: ("platform overview", ["up", "ALERTS", "lims_ops_wal_repo2_newest_age_seconds",
                              "lims_ops_restore_drill_last_success_timestamp_seconds",
                              "lims_ops_offsite_archive_configured"]),
    2: ("edge", ["lims_ops_edge_requests_total", "lims_ops_edge_rate_limited_total",
                 "lims_ops_edge_not_found_max_per_ip_5m", "lims_ops_fail2ban_bans_total",
                 "probe_ssl_earliest_cert_expiry", "lims_ops_egress_denied_total"]),
    3: ("api", ["lims_http_requests_total", "lims_http_request_duration_seconds", "lims_rls_denied_total",
                "lims_core_auth_failures_total", "lims_ratelimit_rejections_total", "up"]),
    4: ("worker", ["lims_queue_depth", "lims_jobs_total", "lims_job_duration_seconds",
                   "lims_core_dead_letters_total"]),
    5: ("postgres", ["pg_stat_activity_count", "pg_settings_max_connections", "pg_stat_database_deadlocks",
                     "pg_stat_activity_max_tx_duration", "pg_replication_slots_pg_wal_lsn_diff",
                     "pg_replication_lag_seconds", "pg_invalid_indexes_count", "pg_database_size_bytes"]),
    6: ("pgbouncer", ["pgbouncer_pools_client_active_connections", "pgbouncer_pools_client_waiting_connections",
                      "pgbouncer_pools_server_active_connections", "pgbouncer_pools_server_idle_connections"]),
    7: ("backup", ["lims_ops_backup_last_success_timestamp_seconds", "lims_ops_backup_duration_seconds",
                   "lims_ops_wal_repo2_newest_age_seconds", "lims_ops_wal_check_consecutive_failures",
                   "lims_ops_restore_drill_last_success_timestamp_seconds", "lims_ops_restore_drill_rto_seconds",
                   "lims_ops_restore_drill_checks_failed", "lims_ops_object_replica_lag_seconds",
                   "pg_replication_lag_seconds"]),
    8: ("audit", ["lims_ops_auditstore_lag_seconds", "lims_ops_auditstore_subscription_enabled",
                  "lims_ops_audit_digest_mismatch_total"]),
    9: ("capacity", ["pg_database_size_bytes", "predict_linear", "node_filesystem_avail_bytes",
                     "container_memory_usage_bytes", "lims_queue_depth"]),
    10: ("renderer", ["lims_ops_container_health", "container_memory_usage_bytes",
                      "lims_reporting_render_failures_total", "lims_reporting_sandbox_rejections_total",
                      "lims_renderer_"]),
    11: ("scanner", ["lims_ops_scanner_signature_age_seconds"]),
    13: ("security", ["lims_identity_logins_total", "lims_rls_denied_total", "lims_ops_ssh_login_outside_ops_total",
                      "lims_ops_sudo_by_unknown_total", "lims_ops_secret_decrypt_unexpected_total",
                      "lims_ops_studio_enabled", "lims_ops_egress_denied_total"]),
    14: ("hosts", ["node_cpu_seconds_total", "node_memory_MemAvailable_bytes", "node_filesystem_avail_bytes",
                   "node_network_receive_bytes_total", "node_timex_offset_seconds",
                   "lims_ops_last_patch_timestamp_seconds"]),
}


def _dash_file(n):
    files = sorted(p for p in DASH.glob("D*.json") if re.match(r"D%d-" % n, p.name)) if DASH.exists() else []
    assert len(files) == 1, "expected exactly one grafana/dashboards/D%d-*.json, found %s" % (n, [f.name for f in files])
    return files[0]


class DashboardsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs = {}
        for n in DASHBOARDS:
            p = _dash_file(n)
            cls.docs[n] = (p, p.read_text(encoding="utf-8"), json.loads(p.read_text(encoding="utf-8")))

    def exprs(self, n):
        doc = self.docs[n][2]
        return [t["expr"] for d in _walk(doc) for t in d.get("targets", []) if isinstance(t, dict) and "expr" in t]

    def test_title_uid_timezone_panels(self):  # 04-UI-UX principle 4 (Nepal time for humans)
        uids = set()
        for n, (key, _) in DASHBOARDS.items():
            p, text, doc = self.docs[n]
            self.assertIn(key, doc["title"].lower(), "D%d title" % n)
            self.assertTrue(doc.get("uid"), "D%d uid" % n)
            self.assertNotIn(doc["uid"], uids, "D%d uid collides" % n)
            uids.add(doc["uid"])
            self.assertEqual(doc.get("timezone"), "Asia/Kathmandu", "D%d timezone" % n)
            self.assertTrue(doc.get("schemaVersion"), "D%d schemaVersion" % n)
            self.assertGreaterEqual(len(doc.get("panels") or []), 3, "D%d panels" % n)

    def test_uid_unique_against_d12_and_d15(self):
        mine = {self.docs[n][2]["uid"] for n in DASHBOARDS}
        for p in DASH.glob("D1[25]-*.json"):
            self.assertNotIn(json.loads(p.read_text(encoding="utf-8")).get("uid"), mine, p.name)

    def test_required_series_have_panels(self):  # 04-UI-UX s3 "Panels (minimum)"
        for n, (_, metrics) in DASHBOARDS.items():
            joined = "\n".join(self.exprs(n))
            for m in metrics:
                self.assertIn(m, joined, "D%d has no panel using %s" % (n, m))

    def test_d1_rpo_gauge_bands_and_drill_age_threshold(self):  # D-205: warn 600 s, page 840 s; 35 d
        text = self.docs[1][1]
        doc = self.docs[1][2]
        steps = []
        for d in _walk(doc):
            if any("lims_ops_wal_repo2_newest_age_seconds" in str(t.get("expr", "")) for t in d.get("targets", []) if isinstance(t, dict)):
                steps += [s.get("value") for s in d.get("fieldConfig", {}).get("defaults", {}).get("thresholds", {}).get("steps", [])]
        self.assertIn(600, steps)
        self.assertIn(840, steps)
        self.assertRegex(text, r"3024000|35 ?d|35\s*\*\s*86400")
        self.assertIn("NoOffsiteArchive", text)
        self.assertTrue(any("ALERTS" in e for e in self.exprs(1)), "firing alerts table")

    def test_d2_all_rate_limit_zones_and_counts(self):
        text = self.docs[2][1]
        for z in ("login", "otp", "psession", "qrverify", "agent", "callback", "payments", "perip"):
            self.assertIn(z, text, "D2 zone %s" % z)
        self.assertIn("dest_class", text)

    def test_d10_memory_limits(self):
        text = self.docs[10][1]
        self.assertRegex(text, r"1610612736|1\.5 ?GiB")
        self.assertRegex(text, r"536870912|512 ?MiB")

    def test_prometheus_datasource_only_no_sql_or_log_datasource(self):  # 02-TRD s11.5, 07-SECURITY
        for n in DASHBOARDS:
            p, text, doc = self.docs[n]
            for d in _walk(doc):
                ds = d.get("datasource")
                if isinstance(ds, dict):
                    self.assertEqual(ds.get("type"), "prometheus", "%s: %s" % (p.name, ds))
            self.assertNotRegex(text, r"(?i)\"type\"\s*:\s*\"(postgres|mysql|mssql|loki|victoria-logs|elasticsearch)")

    def test_no_phi_labels_and_no_literal_host_selectors(self):  # LD-45: both profiles must render
        for n in DASHBOARDS:
            p, text, _ = self.docs[n]
            for lbl in DROP_LABELS:
                self.assertNotRegex(text, r"\b%s\b" % lbl, "%s: %s" % (p.name, lbl))
            for e in self.exprs(n):
                self.assertNotRegex(e, r'host\s*=~?\s*"[^"$]*\b(app|data|dr|ops|prod|backup)-\d', "%s: literal host in %s" % (p.name, e))


if __name__ == "__main__":
    unittest.main()
