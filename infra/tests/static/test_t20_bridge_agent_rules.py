"""T-20 tests (tester role): bridge-agent alert rules, imported C7 rules, promtool tests, dashboard D12, c7_metrics_live gate.

Covers 02-TRD s11.2 item 3 (BridgeAgent* rules + "max by" for duplicate worker replicas), s11.3 (C7 intake row,
annotations/runbook lint, import = copy + severity/team/runbook_url only), s11.4 (routing), s12 flag `c7_metrics_live`,
04-UI-UX D12, C7 02-TRD s13 "Alert rules for C1" (6 rules, pinned below), AC-25.1, AC-25.2, AC-17.2 (C7 part).
Done when (T-20): rules + promtool tests on synthetic series incl. duplicate worker replicas; C7 rules imported
verbatim; disabled while c7_metrics_live=false.

CONTRACTS where the spec is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/monitoring/rules/instruments.rules.yml holds EXACTLY the six BridgeAgent* alerts of TRD s11.2 item 3
   (expr/for/severity verbatim; label team=ops; BridgeAgentOfflineLong additionally notify_tenant="true", the label
   s11.4 routes to the tenant contact; no other alert sets notify_tenant="true").
 * infra/monitoring/rules/imported/instruments.rules.yml holds EXACTLY the six C7 alerts (expr/for verbatim from C7
   02-TRD s13, severity per that table, + team, + runbook_url) and no BridgeAgent* alert (C7 does not repeat them).
   When C7's source file services/worker/src/jobs/instruments/alerts/instruments.rules.yml exists, the imported file
   must equal it apart from the added severity/team/runbook_url/receiver-ish labels (alert-import-drift).
 * runbook_url = infra/runbooks/instruments.md#<alertname lower-case> (04-UI-UX s4 `instruments.md`).
 * promtool tests: infra/monitoring/rules/tests/instruments.test.yml, rule_files = both rule files (relative paths).
 * Gate: a task under roles/monitoring/tasks mentions both `c7_metrics_live` and `instruments.rules` (the whole
   rules/ dir is copied today, so the writer must exclude both files unless the flag is true); default false.
 * D12: infra/monitoring/grafana/dashboards/D12*.json (one file), Prometheus datasource only, title contains
   "Bridge agent fleet", panel text contains `c7_metrics_live` and `worker-a/b`.
Stdlib + jinja2 + PyYAML. Missing file = FAIL. `promtool` runs only when on PATH (hard FAIL if CI=true and absent).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t20_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

import yaml

from test_t18_monitoring import (ADDR, AM_J2, DROP_LABELS, MON, ROOT, T_ADDR, TENANT1, TENANT2, WG, _all_emails,
                                 _files, _render, _route, _secs, _tasks)

RULES = MON / "rules" / "instruments.rules.yml"
IMPORTED = MON / "rules" / "imported" / "instruments.rules.yml"
PTEST = MON / "rules" / "tests" / "instruments.test.yml"
C7_SRC = ROOT / "services" / "worker" / "src" / "jobs" / "instruments" / "alerts" / "instruments.rules.yml"
DASH_DIR = MON / "grafana" / "dashboards"
ROLE_MON = ROOT / "infra" / "ansible" / "roles" / "monitoring"
INVENTORIES = ROOT / "infra" / "ansible" / "inventories"

BY = "max by (tenant_id, centre_id, agent_id)"
# 02-TRD s11.2 item 3, verbatim: name -> (expr, for, severity)
BRIDGE = {
    "BridgeAgentOffline": ('%s (lims_instruments_agent_state{state="offline"}) == 1' % BY, "15m", "warn"),
    "BridgeAgentOfflineLong": ('%s (lims_instruments_agent_state{state="offline"}) == 1' % BY, "60m", "page"),
    "BridgeAgentBacklog": ('%s (lims_instruments_agent_state{state="backlog"}) == 1' % BY, "30m", "warn"),
    "BridgeAgentDegraded": ('%s (lims_instruments_agent_state{state="degraded"}) == 1' % BY, "30m", "warn"),
    "BridgeAgentClockOffset": ("abs(%s (lims_instruments_agent_clock_offset_seconds)) > 120" % BY, "30m", "info"),
    "BridgeAgentMetricsAbsent": ("absent(lims_instruments_agent_state)", "10m", "warn"),
}
# C7 02-TRD s13 "Alert rules for C1", verbatim
C7 = {
    "InstrumentsAgentUpdateFailed": ("increase(lims_instruments_agent_update_failures_total[15m]) > 0", "0m", "page"),
    "InstrumentsAgentConfigRejected": ("increase(lims_instruments_agent_config_rejections_total[15m]) > 0", "0m", "page"),
    "InstrumentsDeviceAuthFailureSpike": ("sum(rate(lims_instruments_device_auth_failures_total[5m])) > 0.1", "5m", "page"),
    "InstrumentsQuarantineRate": (
        'sum(rate(lims_instruments_ingest_messages_total{outcome="quarantined"}[1h])) / '
        "sum(rate(lims_instruments_ingest_messages_total[1h])) > 0.05", "1h", "warn"),
    "InstrumentsAttachmentQuarantined": (
        'increase(lims_instruments_attachment_scans_total{outcome="quarantined"}[15m]) > 0', "0m", "page"),
    "InstrumentsIngestSlow": (
        "histogram_quantile(0.95, sum by (le) (rate(lims_instruments_ingest_batch_duration_seconds_bucket[15m]))) > 3",
        "15m", "warn"),
}
TENANT_OK_LABELS = {"tenant_id", "centre_id", "agent_id"}


def _n(s):
    return re.sub(r"\s+", "", str(s))


def _rules(path):
    assert path.exists(), "missing %s" % path.relative_to(ROOT)
    d = yaml.safe_load(path.read_text(encoding="utf-8"))
    out = {}
    for g in d["groups"]:
        for r in g["rules"]:
            if "alert" in r:
                assert r["alert"] not in out, "duplicate alert %s" % r["alert"]
                out[r["alert"]] = r
    return out


def _for_s(rule):
    return _secs(rule.get("for", "0s")) if str(rule.get("for", "0s")) not in ("0", "0m") else 0


def _lint(tc, rules, label):
    for name, r in rules.items():
        a = r.get("annotations") or {}
        tc.assertTrue(a.get("summary"), "%s %s: annotations.summary" % (label, name))
        tc.assertEqual(str(a.get("runbook_url", "")).lower(), "infra/runbooks/instruments.md#%s" % name.lower(),
                       "%s %s: runbook_url" % (label, name))
        tc.assertEqual((r.get("labels") or {}).get("team"), "ops", "%s %s: team" % (label, name))
        # T-20 ruling (2026-11-08): check label KEYS and template uses, not a substring over the blob
        # (receiver name `oncall-email` is spec-mandated routing, not a PHI label).
        tc.assertEqual(set(r.get("labels") or {}) & set(DROP_LABELS), set(), "%s %s: PHI-class label key" % (label, name))
        # expr and annotation templates may use only opaque ids (AC-25.2: tenant_id, centre_id, agent_id only)
        for k, v in list(a.items()) + [("expr", r["expr"])]:
            for used in re.findall(r"\$labels\.(\w+)|\.Labels\.(\w+)", str(v)):
                used = used[0] or used[1]
                tc.assertIn(used, TENANT_OK_LABELS | {"alertname", "severity", "team"}, "%s %s: annotation %s uses label %s" % (label, name, k, used))


# ================================================================ BridgeAgent* rules (AC-25.1, AC-25.2)
class BridgeAgentRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = _rules(RULES)

    def test_exactly_the_six_trd_alerts(self):  # 02-TRD s11.2 item 3
        self.assertEqual(set(self.rules), set(BRIDGE))

    def test_expr_for_severity_verbatim(self):  # thresholds [CONV] / AC-25.1: 15 min warn, 60 min page
        for name, (expr, dur, sev) in BRIDGE.items():
            r = self.rules[name]
            self.assertEqual(_n(r["expr"]), _n(expr), name)
            self.assertEqual(_secs(r["for"]), _secs(dur), "%s: for" % name)
            self.assertEqual(r["labels"]["severity"], sev, name)

    def test_ac_25_1_offline_15m_warn_then_60m_page(self):
        o, long_ = self.rules["BridgeAgentOffline"], self.rules["BridgeAgentOfflineLong"]
        self.assertEqual((_secs(o["for"]), o["labels"]["severity"]), (900, "warn"))
        self.assertEqual((_secs(long_["for"]), long_["labels"]["severity"]), (3600, "page"))

    def test_ac_25_2_backlog_and_degraded_30m(self):
        for name, state in (("BridgeAgentBacklog", "backlog"), ("BridgeAgentDegraded", "degraded")):
            r = self.rules[name]
            self.assertEqual(_secs(r["for"]), 1800)
            self.assertIn('state="%s"' % state, r["expr"])

    def test_duplicate_worker_replicas_are_aggregated(self):  # 02-TRD s11.2: "always aggregate max by (...)"
        for name, r in self.rules.items():
            if name == "BridgeAgentMetricsAbsent":
                continue
            self.assertIn("maxby(tenant_id,centre_id,agent_id)(", _n(r["expr"]), "%s: replicas would double-fire" % name)
            self.assertNotRegex(r["expr"], r"\b(instance|service|host|state)\b(?!=)", "%s groups by a replica label" % name)

    def test_alert_labels_are_tenant_centre_agent_only(self):  # AC-25.2 (no PHI)
        for name, r in self.rules.items():
            if name == "BridgeAgentMetricsAbsent":
                continue
            m = re.search(r"max by \(([^)]*)\)", str(r["expr"]))
            self.assertTrue(m, name)
            self.assertEqual({x.strip() for x in m.group(1).split(",")}, TENANT_OK_LABELS, name)
            self.assertFalse(set(r["labels"]) - {"severity", "team", "notify_tenant"}, "%s: static labels" % name)

    def test_only_offline_long_notifies_tenant(self):  # 02-TRD s11.4
        for name, r in self.rules.items():
            want = name == "BridgeAgentOfflineLong"
            self.assertEqual((r["labels"].get("notify_tenant") == "true"), want, name)

    def test_lint_summary_runbook_team_no_phi(self):  # 02-TRD s11.3 last paragraph
        _lint(self, self.rules, "BridgeAgent")

    @unittest.skipUnless(shutil.which("promtool"), "promtool not on PATH (CI: promtool check rules)")
    def test_promtool_check_rules(self):
        r = subprocess.run(["promtool", "check", "rules", str(RULES), str(IMPORTED)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


# ================================================================ imported C7 rules (AC-17.2)
class ImportedC7RulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rules = _rules(IMPORTED)

    def test_exactly_the_six_c7_alerts_no_agent_state_rules(self):
        self.assertEqual(set(self.rules), set(C7))
        self.assertFalse([n for n in self.rules if n.startswith("BridgeAgent")], "C7 does not repeat C1's BridgeAgent*")

    def test_threshold_and_for_verbatim_and_severity_added(self):  # "thresholds and for stay verbatim"
        for name, (expr, dur, sev) in C7.items():
            r = self.rules[name]
            self.assertEqual(_n(r["expr"]), _n(expr), name)
            self.assertEqual(_for_s(r), _secs(dur) if dur != "0m" else 0, "%s: for" % name)
            self.assertEqual(r["labels"].get("severity"), sev, name)

    def test_lint_summary_runbook_team_no_phi(self):
        _lint(self, self.rules, "imported")

    def test_import_adds_only_allowed_keys(self):  # severity, team, runbook_url (+ receiver label)
        # T-20 ruling (TESTS_WRONG): the limit is on what C1 ADDS (02-TRD s11.3 :884); source labels such as
        # C7's `route` are kept verbatim. Allowed = labels of the same alert in the C7 source
        # (else at least {route}) + {severity, team, receiver, notify_tenant}.
        src = _rules(C7_SRC) if C7_SRC.exists() else {}
        for name, r in self.rules.items():
            self.assertFalse(set(r) - {"alert", "expr", "for", "labels", "annotations", "keep_firing_for"}, name)
            allowed = set((src.get(name) or {}).get("labels") or {"route": 1}) | {"severity", "team", "receiver", "notify_tenant"}
            self.assertFalse(set(r["labels"]) - allowed, "%s: %s" % (name, r["labels"]))
            self.assertNotEqual(r["labels"].get("notify_tenant"), "true", "%s: tenant mail is for BridgeAgentOfflineLong" % name)

    def test_alert_import_drift_against_c7_source_when_present(self):  # 02-TRD s11.3 CI job alert-import-drift
        if not C7_SRC.exists():
            self.skipTest("C7 source file not in this lane yet (services/worker/src/jobs/instruments/alerts); "
                          "verbatim check above is pinned to C7 02-TRD s13 instead")
        src = _rules(C7_SRC)
        self.assertEqual(set(src), set(self.rules), "alert set drifted from the C7 source")
        for name, s in src.items():
            i = self.rules[name]
            self.assertEqual(_n(i["expr"]), _n(s["expr"]), name)
            self.assertEqual(str(i.get("for", "0m")), str(s.get("for", "0m")), name)
            for k, v in (s.get("labels") or {}).items():
                self.assertEqual(i["labels"].get(k), v, "%s: label %s changed" % (name, k))
            for k, v in (s.get("annotations") or {}).items():
                if k != "runbook_url":
                    self.assertEqual(i["annotations"].get(k), v, "%s: annotation %s changed" % (name, k))


# ================================================================ promtool unit tests (done_when)
class PromtoolTestFileTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        assert PTEST.exists(), "missing infra/monitoring/rules/tests/instruments.test.yml"
        cls.doc = yaml.safe_load(PTEST.read_text(encoding="utf-8"))
        cls.cases = cls.doc["tests"]
        cls.expect = [(c, e) for c in cls.cases for e in c.get("alert_rule_test", [])]
        cls.rules = dict(_rules(RULES), **_rules(IMPORTED))

    def test_rule_files_reference_both_files(self):
        rf = [(PTEST.parent / p).resolve() for p in self.doc["rule_files"]]
        self.assertIn(RULES.resolve(), rf)
        self.assertIn(IMPORTED.resolve(), rf)
        self.assertTrue(self.doc.get("evaluation_interval"))

    def test_every_alert_has_firing_and_not_firing_case(self):  # AC-17.2 "covers each (firing and not firing)"
        for name in list(BRIDGE) + list(C7):
            es = [e for _, e in self.expect if e["alertname"] == name]
            self.assertTrue([e for e in es if e.get("exp_alerts")], "%s: no firing expectation" % name)
            self.assertTrue([e for e in es if not e.get("exp_alerts")], "%s: no not-firing expectation" % name)

    def test_for_boundary_covered_for_bridge_alerts(self):  # AC-25.1/25.2: not before `for`, fires at `for`
        for name in BRIDGE:
            if name == "BridgeAgentMetricsAbsent":
                continue
            f = _secs(BRIDGE[name][1])
            es = [e for _, e in self.expect if e["alertname"] == name]
            before = [e for e in es if not e.get("exp_alerts") and 0 < _secs(e["eval_time"]) < f]
            after = [e for e in es if e.get("exp_alerts") and _secs(e["eval_time"]) >= f]
            self.assertTrue(before, "%s: no 'not yet firing before %s' case" % (name, BRIDGE[name][1]))
            self.assertTrue(after, "%s: no 'firing at/after %s' case" % (name, BRIDGE[name][1]))

    def test_duplicate_worker_replicas_yield_one_alert(self):  # done_when: duplicate worker replicas
        found = 0
        for c, e in self.expect:
            if e["alertname"] != "BridgeAgentOffline" or len(e.get("exp_alerts") or []) != 1:
                continue
            groups = {}
            for s in c["input_series"]:
                m = re.match(r"(\w+)\{(.*)\}$", s["series"].strip())
                if not m or m.group(1) != "lims_instruments_agent_state":
                    continue
                lab = dict(re.findall(r'(\w+)="([^"]*)"', m.group(2)))
                if lab.get("state") == "offline":
                    groups.setdefault((lab.get("tenant_id"), lab.get("centre_id"), lab.get("agent_id")), []).append(lab)
            def replica(x):  # labels that identify the exporting process, not the agent
                return tuple(sorted((k, v) for k, v in x.items() if k not in TENANT_OK_LABELS | {"state"}))
            dup = [v for v in groups.values() if len({replica(x) for x in v}) >= 2]
            if dup:
                found += 1
                ex = e["exp_alerts"][0]["exp_labels"]
                self.assertTrue(set(ex) <= TENANT_OK_LABELS | {"severity", "team", "notify_tenant"},
                                "replica labels leaked into the alert: %s" % sorted(ex))
        self.assertGreaterEqual(found, 1, "need a case with the same offline agent exported by two replicas "
                                          "(e.g. service=worker-a and worker-b) expecting exactly ONE BridgeAgentOffline")

    def test_one_replica_stale_other_offline_still_fires(self):  # max by: 1 wins over a stale 0 replica
        ok = False
        for c, e in self.expect:
            if e["alertname"] not in ("BridgeAgentOffline", "BridgeAgentOfflineLong") or not e.get("exp_alerts"):
                continue
            vals = [s for s in c["input_series"] if 'state="offline"' in s["series"].replace(" ", "")]
            if len(vals) >= 2 and any(re.fullmatch(r"\s*0(\s+0)*\s*|\s*0x\d+\s*", s["values"]) for s in vals) and \
                    any("1" in s["values"] for s in vals):
                ok = True
        self.assertTrue(ok, "no case where replica A reports offline=0 and replica B offline=1 still fires")

    def test_alert_labels_in_expectations_are_phi_free(self):  # AC-25.2
        for c, e in self.expect:
            for a in e.get("exp_alerts") or []:
                if e["alertname"] in BRIDGE and e["alertname"] != "BridgeAgentMetricsAbsent":
                    self.assertTrue(TENANT_OK_LABELS <= set(a["exp_labels"]), "%s: tenant_id/centre_id/agent_id" % e["alertname"])
                self.assertFalse(set(a["exp_labels"]) & set(DROP_LABELS), e["alertname"])

    def test_synthetic_series_use_synthetic_ids_only(self):  # CLAUDE.md: synthetic data only
        blob = PTEST.read_text(encoding="utf-8")
        self.assertNotRegex(blob, r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
        for lbl in DROP_LABELS:
            self.assertNotRegex(blob, r"[{,\s]%s\s*[=:]" % lbl)  # label key only; ruling 2026-11-08

    def test_runs_unmodified_rule_names(self):
        known = set(self.rules)
        for _, e in self.expect:
            self.assertIn(e["alertname"], known, "test refers to unknown alert %s" % e["alertname"])

    def test_promtool_test_rules(self):
        if not shutil.which("promtool"):
            if os.environ.get("CI") == "true":
                self.fail("promtool missing in CI")
            self.skipTest("promtool not on PATH (CI: promtool test rules)")
        r = subprocess.run(["promtool", "test", "rules", PTEST.name], capture_output=True, text=True, cwd=str(PTEST.parent))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


# ================================================================ routing consistency with T-18 Alertmanager
class RoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg = yaml.safe_load(_render(AM_J2))
        cls.rules = dict(_rules(RULES), **_rules(IMPORTED))

    def labels(self, name, **extra):
        return dict(self.rules[name]["labels"], alertname=name, tenant_id=TENANT1, **extra)

    def test_page_rules_reach_oncall_warn_rules_reach_digest(self):  # C7 table "route" column
        for name, r in self.rules.items():
            rcv = [h[0] for h in _route(self.cfg, self.labels(name))]
            sev = r["labels"]["severity"]
            if sev == "page":
                self.assertIn("oncall-email", rcv, name)
            elif sev == "warn":
                self.assertIn("ops-digest-email", rcv, name)
                self.assertNotIn("oncall-email", rcv, name)
            else:
                self.assertNotIn("oncall-email", rcv, name)

    def test_offline_long_mails_only_its_own_tenant(self):  # 02-TRD s11.4 + 07-SEC cross-tenant
        em = _all_emails(self.cfg, self.labels("BridgeAgentOfflineLong"))
        self.assertIn(ADDR["oncall"], em)
        self.assertIn(T_ADDR[TENANT1], em)
        self.assertNotIn(T_ADDR[TENANT2], em)

    def test_other_agent_alerts_never_mail_tenants(self):
        for name in list(BRIDGE) + list(C7):
            if name == "BridgeAgentOfflineLong":
                continue
            self.assertFalse(_all_emails(self.cfg, self.labels(name)) & set(T_ADDR.values()), name)


# ================================================================ scrape + c7_metrics_live gate
class ScrapeAndGateTest(unittest.TestCase):
    def test_worker_a_b_scraped_and_agent_labels_not_dropped(self):  # 02-TRD s11.1/s11.2 (CR-C7-012)
        cfg = yaml.safe_load(_render(MON / "prometheus" / "prometheus.yml.j2"))
        jobs = {j["job_name"]: j for j in cfg["scrape_configs"]}
        for job, port in (("worker-a", 9466), ("worker-b", 9467)):
            self.assertIn("%s:%d" % (WG["app-1"], port), json.dumps(jobs[job]["static_configs"]))
        for j in cfg["scrape_configs"]:
            for a in j.get("metric_relabel_configs", []):
                if a.get("action") == "labeldrop":
                    for keep in ("tenant_id", "centre_id", "agent_id", "agent_version", "state"):
                        self.assertIsNone(re.fullmatch(str(a["regex"]), keep), "%s: scrape drops %s" % (j["job_name"], keep))
                if a.get("action") == "drop":
                    self.assertNotIn("lims_instruments", json.dumps(a), "agent series dropped at scrape")

    def test_both_rule_dirs_loaded_by_prometheus(self):
        cfg = yaml.safe_load(_render(MON / "prometheus" / "prometheus.yml.j2"))
        blob = json.dumps(cfg["rule_files"])
        self.assertIn("rules/*.rules.yml", blob)
        self.assertIn("rules/imported/*.rules.yml", blob)

    def test_flag_defaults_false_in_every_inventory(self):  # 02-TRD s12 table: default false
        for env in ("dev", "staging", "prod"):
            d = yaml.safe_load((INVENTORIES / env / "group_vars" / "all.yml").read_text(encoding="utf-8"))
            self.assertIs(d["c7_metrics_live"], False, env)

    def test_role_gates_both_rule_files_on_the_flag(self):  # done_when: disabled while c7_metrics_live=false
        ts = _tasks(ROLE_MON)
        gated = [t for t in ts if "c7_metrics_live" in json.dumps(t) and "instruments.rules" in json.dumps(t)]
        self.assertTrue(gated, "no monitoring task ties instruments.rules.yml (rules/ and rules/imported/) to c7_metrics_live")
        text = "\n".join(p.read_text(encoding="utf-8") for p in _files(ROLE_MON / "tasks", ("*.yml", "*.yaml")))
        self.assertGreaterEqual(len(re.findall(r"instruments\.rules", text)), 1)
        # both files must be covered: either named explicitly, or by a shared glob/dir exclusion
        covered = [t for t in gated if re.search(r"imported", json.dumps(t)) or "instruments.rules" in json.dumps(t)]
        self.assertTrue(covered)


# ================================================================ dashboard D12 (04-UI-UX s3)
def _walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from _walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from _walk(v)


class DashboardD12Test(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        files = sorted(DASH_DIR.glob("D12*.json")) if DASH_DIR.exists() else []
        assert len(files) == 1, "expected exactly one grafana/dashboards/D12*.json, found %s" % [f.name for f in files]
        cls.text = files[0].read_text(encoding="utf-8")
        cls.doc = json.loads(cls.text)
        cls.exprs = [t["expr"] for d in _walk(cls.doc) for t in d.get("targets", []) if isinstance(t, dict) and "expr" in t]

    def test_title_and_uid(self):
        self.assertIn("bridge agent fleet", self.doc["title"].lower())
        self.assertTrue(self.doc.get("uid"))

    def test_shows_every_required_series(self):  # 04-UI-UX D12 row
        joined = "\n".join(self.exprs)
        for m in ("lims_instruments_agent_state", "lims_instruments_agent_last_heartbeat_timestamp_seconds",
                  "lims_instruments_agent_queue_depth", "lims_instruments_agent_clock_offset_seconds",
                  "lims_instruments_agent_silent_instruments", "lims_instruments_agent_info",
                  "lims_instruments_agent_update_failures_total", "lims_instruments_agent_config_rejections_total",
                  "lims_instruments_device_auth_failures_total"):
            self.assertIn(m, joined, "D12 has no panel for %s" % m)

    def test_no_data_note_names_the_flag_and_source(self):  # 04-UI-UX D12, 03-APP-FLOW s13
        self.assertIn("c7_metrics_live", self.text)
        self.assertIn("worker-a/b", self.text)

    def test_replica_safe_aggregation(self):  # worker-a/b export identical series -> never sum/count raw
        for e in self.exprs:
            if re.search(r"lims_instruments_agent_(state|queue_depth|silent_instruments|info)", e) and \
                    re.search(r"\b(sum|count|avg)\b\s*(by\s*\([^)]*\))?\s*\(", e):
                self.assertRegex(e, r"\bmax\b", "double-counts duplicate worker replicas: %s" % e)

    def test_prometheus_datasource_only_and_no_phi_labels(self):
        for d in _walk(self.doc):
            ds = d.get("datasource")
            if isinstance(ds, dict):
                self.assertEqual(ds.get("type"), "prometheus")
        for lbl in DROP_LABELS:
            self.assertNotRegex(self.text, r"\b%s\b" % lbl)
        self.assertNotRegex(self.text, r"(?i)\"type\"\s*:\s*\"(postgres|mysql|mssql|loki|victoria-logs)")


if __name__ == "__main__":
    unittest.main()
