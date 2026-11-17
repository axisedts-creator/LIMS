"""T-18 tests (tester role): monitoring core - Prometheus, Alertmanager, Grafana, blackbox, ops nginx, internal CA, ops-note.sh.

Covers 02-TRD s3.3 (ports), s8.2 (secret ids), s11.1, s11.4, s11.5, 04-UI-UX s5.2 (ops-note), AC-17.1, AC-17.3,
07-SEC rows A5/secrets (CA key, e-mail addresses are personal data and never in git), 06-PLAN row T-18.
Done when (T-18): all targets up; e-mail via relay delivers a test page; Watchdog to a second mailbox; Grafana roles;
internal CA issues ops nginx + registry certs (CA key only in the secret store); no e-mail address in git.

NOT provable here (marked in .orchestra/notes/T-18-tests.md): `up == 1` on real hosts, real SMTP delivery via the
relay, real certificate issuance, Grafana login. Those are in infra/tests/integration/test_t18_live.py (LIMS_T18_LIVE=1).
`promtool check config|rules` / `amtool check-config` run only when the binary is on PATH (CI has them; the pinned
versions are 3.16.0 / 0.34.2) - otherwise that single test is skipped with a visible reason.

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * Paths: infra/monitoring/prometheus/prometheus.yml.j2 (+ optional prometheus/targets/*.yml.j2 file_sd),
   infra/monitoring/alertmanager/alertmanager.yml.j2 + templates/lims.tmpl, infra/monitoring/blackbox/blackbox.yml,
   infra/monitoring/grafana/provisioning/{datasources,dashboards}/*.yml, infra/monitoring/rules/ops.rules.yml
   (holds at least `Watchdog` and `TargetDown`; T-19 extends it), roles/monitoring (+ an ops-nginx template whose file
   name contains "nginx"), roles/internal_ca, infra/pki/README.md, infra/ci/ops-note.sh.
 * Jinja context supplied to the .j2 files: groups, hostvars[h].wg_ip, inventory_hostname, wg_ip (= ops-1 IP),
   env, smtp_relay_fqdn, smtp_from, alert_contacts{oncall, escalation, finance_oncall, watchdog},
   tenant_ops_contacts{<tenant_id>: <address>}. Unknown variables render as UNDEF_<name>.
 * Alertmanager: receivers `oncall-email`, `ops-digest-email`, `finance-oncall-email`, `oncall-sms` (no e-mail, not
   routed), one `tenant-admin-email*` receiver per tenant (name starts with `tenant-admin-email`); the finance route is
   chosen by label team="finance"; the tenant route by notify_tenant="true" + tenant_id; a `lab_hours` time interval
   (06:00-20:00 Asia/Kathmandu) gates BridgeAgentOfflineLong via `active_time_intervals`; the SMTP password is a file
   (`smtp_auth_password_file`), never inline.
 * ops-note.sh "<text>": prints/logs ONE JSON object per call with stream="ops_audit", who, what (= the text), when
   (ISO-8601 UTC); written to stdout and/or via `logger` on PATH; empty text -> non-zero exit, nothing logged.
Stdlib + jinja2 + PyYAML. Missing file = FAIL.
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t18_*.py" -v
"""
import datetime
import json
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
MON = ROOT / "infra" / "monitoring"
PROM_J2 = MON / "prometheus" / "prometheus.yml.j2"
AM_J2 = MON / "alertmanager" / "alertmanager.yml.j2"
AM_TMPL = MON / "alertmanager" / "templates" / "lims.tmpl"
BLACKBOX = MON / "blackbox" / "blackbox.yml"
GRAF = MON / "grafana" / "provisioning"
OPS_RULES = MON / "rules" / "ops.rules.yml"
ROLE_MON = ROOT / "infra" / "ansible" / "roles" / "monitoring"
ROLE_CA = ROOT / "infra" / "ansible" / "roles" / "internal_ca"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
PKI = ROOT / "infra" / "pki" / "README.md"
OPSNOTE = ROOT / "infra" / "ci" / "ops-note.sh"
SCHEMAS = ROOT / "infra" / "secrets" / "schema"

WG = {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"}
AT = "@"
ADDR = {k: "%s%s%s.invalid" % (k, AT, "t18") for k in ("oncall", "escalation", "finance", "watchdog")}
TENANT1, TENANT2 = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
T_ADDR = {TENANT1: "lab1%sone.invalid" % AT, TENANT2: "lab2%stwo.invalid" % AT}
DROP_LABELS = "patient_id|order_id|specimen_id|barcode|user_id|membership_id|email|phone".split("|")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
# (service, port, hosts) from 02-TRD s3.3 / s11.1
TARGETS = [("node", 9100, list(WG)), ("fluent-bit", 2020, list(WG)), ("cadvisor", 8081, ["app-1", "data-1"]),
           ("postgres_exporter", 9187, ["data-1", "dr-1"]), ("pgbouncer_exporter", 9127, ["data-1"]),
           ("postgres_exporter_audit", 9188, ["dr-1"]), ("nginx_exporter", 9113, ["app-1"]),
           ("api-a", 9464, ["app-1"]), ("api-b", 9465, ["app-1"]), ("worker-a", 9466, ["app-1"]),
           ("worker-b", 9467, ["app-1"])]


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


def _ctx(**over):
    groups = {"data": ["data-1"], "app": ["app-1"], "dr": ["dr-1"], "ops": ["ops-1"],
              "all": list(WG)}
    c = {"groups": groups, "hostvars": {h: {"wg_ip": ip, "inventory_hostname": h} for h, ip in WG.items()},
         "inventory_hostname": "ops-1", "wg_ip": WG["ops-1"], "env": "prod", "smtp_relay_fqdn": "smtp.relay.invalid",
         "smtp_from": "alerts%sfrom.invalid" % AT,
         "alert_contacts": {"oncall": ADDR["oncall"], "escalation": ADDR["escalation"],
                            "finance_oncall": ADDR["finance"], "watchdog": ADDR["watchdog"]},
         "tenant_ops_contacts": dict(T_ADDR)}
    c.update(over)
    return c


def _render(path, **over):
    assert path.exists(), "missing %s" % path.relative_to(ROOT)
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True,
                             loader=jinja2.FileSystemLoader(str(path.parent)))
    return env.from_string(path.read_text(encoding="utf-8")).render(**_ctx(**over))


def _load(path, **over):
    return yaml.safe_load(_render(path, **over))


def _files(d, pats=("*",)):
    return sorted(p for pat in pats for p in d.rglob(pat) if p.is_file()) if d.exists() else []


def _ops_text():
    """All text of the monitoring stack definition: infra/monitoring, the two roles, infra/compose/ops if present."""
    out = []
    for d in (MON, ROLE_MON, ROLE_CA, ROOT / "infra" / "compose" / "ops"):
        for p in _files(d):
            if p.suffix in (".sh", ".pyc") and p.parent.name == "textfile":
                continue
            try:
                out.append(p.read_text(encoding="utf-8"))
            except UnicodeDecodeError:
                pass
    return "\n".join(out)


def _secs(s):
    m = re.fullmatch(r"(\d+)(ms|s|m|h|d)", str(s).strip())
    assert m, "bad duration %r" % s
    return int(m.group(1)) * {"ms": 0.001, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


# ---------------------------------------------------------------- alertmanager route simulator
def _matchers(route):
    out = []
    for m in route.get("matchers", []) or route.get("matchers_list", []):
        mm = re.fullmatch(r'\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!~|!=|=)\s*"?(.*?)"?\s*', str(m))
        assert mm, "unparseable matcher %r" % m
        out.append(mm.groups())
    for k, v in (route.get("match") or {}).items():
        out.append((k, "=", str(v)))
    for k, v in (route.get("match_re") or {}).items():
        out.append((k, "=~", str(v)))
    return out


def _matches(route, labels):
    for k, op, v in _matchers(route):
        have = str(labels.get(k, ""))
        ok = {"=": have == v, "!=": have != v, "=~": re.fullmatch(v, have) is not None,
              "!~": re.fullmatch(v, have) is None}[op]
        if not ok:
            return False
    return True


def _route(cfg, labels):
    """-> list of (receiver, chain[list of route dicts]) honouring `continue` (Alertmanager semantics)."""
    hits = []

    def walk(route, chain):
        chain = chain + [route]
        stopped = False
        for child in route.get("routes", []) or []:
            if _matches(child, labels):
                sub = walk(child, chain)
                if sub:
                    stopped = True
                if not child.get("continue"):
                    return True
        if not stopped:
            hits.append((route.get("receiver"), chain))
        return True

    walk(cfg["route"], [])
    # root with no matching child -> root receiver (handled by walk); dedupe
    return hits


def _eff(chain, key):
    for r in reversed(chain):
        if key in r:
            return r[key]
    return None


def _emails(cfg, receiver):
    rc = next((r for r in cfg.get("receivers", []) if r.get("name") == receiver), None)
    assert rc is not None, "receiver %s not defined" % receiver
    out = set()
    for e in rc.get("email_configs", []) or []:
        out.update(x.strip() for x in str(e.get("to", "")).split(",") if x.strip())
    return out


def _all_emails(cfg, labels):
    s = set()
    for rcv, _ in _route(cfg, labels):
        s |= _emails(cfg, rcv)
    return s


def _rules_by_name():
    assert OPS_RULES.exists(), "missing infra/monitoring/rules/ops.rules.yml"
    d = yaml.safe_load(OPS_RULES.read_text(encoding="utf-8"))
    return {r["alert"]: r for g in d["groups"] for r in g["rules"] if "alert" in r}


# ================================================================ Prometheus
class PrometheusTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = _render(PROM_J2)
        cls.cfg = yaml.safe_load(cls.text)

    def test_global_intervals(self):  # 02-TRD s11.1
        g = self.cfg["global"]
        self.assertEqual(_secs(g["scrape_interval"]), 30)
        self.assertEqual(_secs(g["scrape_timeout"]), 10)
        self.assertLessEqual(_secs(g.get("evaluation_interval", "1m")), 30, "AC-17.3: page e-mail within 2 min")

    def test_retention_90d_flag(self):
        self.assertIn("--storage.tsdb.retention.time=90d", _ops_text())

    def test_pinned_versions(self):  # 02-TRD s2
        t = _ops_text()
        for v in ("3.16.0", "0.34.2", "13.3.0", "0.29.1"):
            self.assertIn(v, t, "pinned version %s (Prometheus/Alertmanager/Grafana/blackbox) missing" % v)
        self.assertNotRegex(t, r"(?i)image:\s*\S+:latest\b")

    def test_every_service_target_on_its_wg_ip(self):  # AC-17.1 (each service is scraped)
        files = [self.text] + [_render(p) for p in _files(MON / "prometheus" / "targets", ("*.j2", "*.yml", "*.yaml"))]
        blob = "\n".join(files)
        for svc, port, hosts in TARGETS:
            for h in hosts:
                self.assertIn("%s:%d" % (WG[h], port), blob, "no scrape target %s:%d (%s on %s)" % (WG[h], port, svc, h))

    def test_targets_only_wg_ips(self):  # 02-TRD s11.1 "targets over wg0 only"
        files = [self.text] + [_render(p) for p in _files(MON / "prometheus" / "targets", ("*.j2", "*.yml", "*.yaml"))]
        for ip in set(re.findall(r"\b(\d{1,3}(?:\.\d{1,3}){3}):\d+", "\n".join(files))):
            self.assertTrue(ip in WG.values() or ip == "127.0.0.1", "scrape target on non-wg IP %s" % ip)
        self.assertNotIn("0.0.0.0", "\n".join(files))

    def test_host_and_service_labels_added_at_scrape_time(self):  # 02-TRD s11.2 item 1
        blob = self.text + "\n".join(_render(p) for p in _files(MON / "prometheus" / "targets", ("*.j2", "*.yml", "*.yaml")))
        for h in WG:
            self.assertRegex(blob, r"host['\"]?\s*:\s*['\"]?%s\b" % h, "label host=%s missing" % h)
        self.assertRegex(blob, r"service['\"]?\s*:")
        self.assertRegex(blob, r"env['\"]?\s*:\s*['\"]?prod")

    def test_label_drop_list_for_phi_ids(self):  # 02-TRD s11.2 item 2
        drop = [a for j in self.cfg["scrape_configs"] for a in j.get("metric_relabel_configs", [])
                if a.get("action") == "labeldrop"]
        self.assertTrue(drop, "no labeldrop metric_relabel_configs")
        for lbl in DROP_LABELS:
            self.assertTrue(any(re.fullmatch(str(a["regex"]), lbl) for a in drop), "label %s not dropped" % lbl)
        for j in self.cfg["scrape_configs"]:
            if j.get("job_name", "").startswith(("blackbox", "probe")):
                continue
            self.assertTrue(any(a.get("action") == "labeldrop" for a in j.get("metric_relabel_configs", [])),
                            "job %s lacks the drop list" % j.get("job_name"))

    def test_rule_files_and_alertmanager(self):
        self.assertTrue(self.cfg.get("rule_files"), "rule_files empty")
        ams = self.cfg["alerting"]["alertmanagers"]
        self.assertTrue(ams and ams[0].get("static_configs"), "alerting.alertmanagers missing")
        self.assertIn(":9093", json.dumps(ams))

    def test_blackbox_jobs(self):  # 02-TRD s11.1: https origins, /v/<invalid>, forbidden-port TCP
        jobs = [j for j in self.cfg["scrape_configs"] if "probe" in j.get("metrics_path", "") or "blackbox" in j.get("job_name", "")]
        self.assertGreaterEqual(len(jobs), 2, "need an HTTP probe job and a TCP-connect probe job")
        self.assertTrue(any("tcp" in json.dumps(j).lower() for j in jobs), "no TCP probe job")
        blob = self.text + "\n".join(_render(p) for p in _files(MON / "prometheus" / "targets", ("*.j2", "*.yml", "*.yaml")))
        self.assertIn("/v/", blob, "no probe of /v/<invalid-token>")
        for j in jobs:
            self.assertIn("__param_target", json.dumps(j), "job %s lacks relabel to __param_target" % j.get("job_name"))

    @unittest.skipUnless(shutil.which("promtool"), "promtool not on PATH (CI: promtool check config)")
    def test_promtool_check_config(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "prometheus.yml").write_text(self.text)
            r = subprocess.run(["promtool", "check", "config", "--syntax-only", str(Path(d) / "prometheus.yml")],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    @unittest.skipUnless(shutil.which("promtool"), "promtool not on PATH (CI: promtool check rules)")
    def test_promtool_check_rules(self):
        r = subprocess.run(["promtool", "check", "rules", str(OPS_RULES)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class RulesTest(unittest.TestCase):
    def test_watchdog_always_firing(self):  # 02-TRD s11.4 dead man's switch
        r = _rules_by_name()["Watchdog"]
        self.assertRegex(str(r["expr"]).replace(" ", ""), r"^vector\(1\)$")

    def test_target_down_ac_17_1(self):  # AC-17.1: missing target for 2 min -> TargetDown
        r = _rules_by_name()["TargetDown"]
        self.assertEqual(_secs(r["for"]), 120)
        self.assertRegex(str(r["expr"]).replace(" ", ""), r"up==0")

    def test_every_rule_has_summary_runbook_and_no_phi_labels(self):  # 02-TRD s11.3
        for name, r in _rules_by_name().items():
            a = r.get("annotations") or {}
            self.assertTrue(a.get("summary"), "%s: annotations.summary" % name)
            self.assertRegex(str(a.get("runbook_url", "")), r"runbooks/[A-Za-z0-9_-]+\.md#", "%s: runbook_url" % name)
            blob = json.dumps(r)
            for lbl in DROP_LABELS:
                self.assertNotRegex(blob, r"\b%s\b" % lbl, "%s mentions PHI-class label %s" % (name, lbl))
            self.assertIn("team", r.get("labels", {}), "%s: team label" % name)


# ================================================================ Alertmanager
class AlertmanagerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = _render(AM_J2)
        cls.cfg = yaml.safe_load(cls.text)
        cls.names = {r["name"] for r in cls.cfg["receivers"]}

    def test_receivers(self):  # 02-TRD s11.4
        for n in ("oncall-email", "ops-digest-email", "finance-oncall-email", "oncall-sms"):
            self.assertIn(n, self.names)
        self.assertEqual(len([n for n in self.names if n.startswith("tenant-admin-email")]) >= 2, True,
                         "one tenant-admin-email* receiver per tenant in tenant_ops_contacts")

    def test_page_goes_to_oncall_247_within_2_min(self):  # AC-17.3
        for alert in ("WalArchiveFailing", "ForbiddenPortOpen", "SiteADown", "ValkeyDown"):
            lbl = {"alertname": alert, "severity": "page", "team": "ops"}
            hits = _route(self.cfg, lbl)
            self.assertIn("oncall-email", [h[0] for h in hits], alert)
            self.assertIn(ADDR["oncall"], _all_emails(self.cfg, lbl))
            for rcv, chain in hits:
                if rcv == "oncall-email":
                    self.assertFalse(any(r.get("active_time_intervals") for r in chain),
                                     "%s must page 24/7 (time interval on its route)" % alert)
                    self.assertLessEqual(_secs(_eff(chain, "group_wait") or "30s"), 60, "group_wait > 60 s breaks AC-17.3")

    def test_warn_goes_to_digest_group_interval_30m(self):
        lbl = {"alertname": "HostDiskHigh", "severity": "warn", "team": "ops"}
        hits = dict(_route(self.cfg, lbl))
        self.assertIn("ops-digest-email", hits)
        self.assertNotIn("oncall-email", hits)
        self.assertEqual(_secs(_eff(hits["ops-digest-email"], "group_interval")), 1800)

    def test_finance_route(self):  # CR-C15-008 item 6
        lbl = {"alertname": "PaymentHeldForReview", "severity": "warn", "team": "finance"}
        self.assertIn("finance-oncall-email", [h[0] for h in _route(self.cfg, lbl)])
        self.assertIn(ADDR["finance"], _all_emails(self.cfg, lbl))
        self.assertNotIn(ADDR["finance"], _all_emails(self.cfg, {"alertname": "X", "severity": "page", "team": "ops"}))

    def test_watchdog_to_second_mailbox_every_6h(self):  # done_when
        r = _rules_by_name()["Watchdog"]
        lbl = dict(r.get("labels", {}), alertname="Watchdog")
        hits = _route(self.cfg, lbl)
        self.assertEqual(len(hits), 1, "Watchdog must reach exactly one receiver")
        rcv, chain = hits[0]
        self.assertEqual(_emails(self.cfg, rcv), {ADDR["watchdog"]})
        self.assertEqual(_secs(_eff(chain, "repeat_interval")), 6 * 3600)
        for other in ("oncall-email", "ops-digest-email", "finance-oncall-email"):
            self.assertNotIn(ADDR["watchdog"], _emails(self.cfg, other), "Watchdog mailbox must be a separate mailbox")
        # and real alerts never reach the Watchdog mailbox
        self.assertNotIn(ADDR["watchdog"], _all_emails(self.cfg, {"alertname": "X", "severity": "page", "team": "ops"}))

    def test_tenant_routing_has_no_cross_tenant_leak(self):  # 07-SEC: addresses are personal data
        lbl = {"alertname": "BridgeAgentOfflineLong", "severity": "page", "team": "ops",
               "notify_tenant": "true", "tenant_id": TENANT1}
        em = _all_emails(self.cfg, lbl)
        self.assertIn(T_ADDR[TENANT1], em)
        self.assertNotIn(T_ADDR[TENANT2], em)
        plain = _all_emails(self.cfg, {"alertname": "HostDiskHigh", "severity": "warn", "team": "ops", "tenant_id": TENANT1})
        self.assertFalse(plain & set(T_ADDR.values()), "tenants are mailed only when notify_tenant=\"true\"")

    def test_bridge_agent_offline_long_only_in_lab_hours(self):  # 02-TRD s11.4
        lbl = {"alertname": "BridgeAgentOfflineLong", "severity": "page", "team": "ops"}
        gated = [chain for rcv, chain in _route(self.cfg, lbl) if rcv == "oncall-email"]
        self.assertTrue(gated, "BridgeAgentOfflineLong must still page oncall in lab hours")
        for chain in gated:
            self.assertTrue(any("lab_hours" in (r.get("active_time_intervals") or []) for r in chain))
        ti = {t["name"]: t for t in self.cfg.get("time_intervals", [])}
        self.assertIn("lab_hours", ti)
        j = json.dumps(ti["lab_hours"])
        self.assertIn("06:00", j)
        self.assertIn("20:00", j)
        self.assertIn("Asia/Kathmandu", j)

    def test_sms_receiver_disabled(self):
        sms = next(r for r in self.cfg["receivers"] if r["name"] == "oncall-sms")
        self.assertFalse(sms.get("email_configs"))
        for lbl in ({"severity": "page", "team": "ops"}, {"severity": "warn", "team": "ops"}):
            self.assertNotIn("oncall-sms", [h[0] for h in _route(self.cfg, dict(lbl, alertname="X"))])

    def test_inhibitions(self):  # 02-TRD s11.4
        inh = json.dumps(self.cfg.get("inhibit_rules"))
        self.assertIn("TargetDown", inh)
        self.assertIn("data-1", inh)
        self.assertIn("SiteADown", inh)

    def test_target_down_inhibits_only_db_family(self):  # 02-TRD s11.4 / s11.3 (review item 2)
        for rule in self.cfg.get("inhibit_rules") or []:
            if "TargetDown" not in json.dumps(rule.get("source_matchers") or rule.get("source_match") or ""):
                continue
            if "data-1" not in json.dumps(rule):
                continue
            tgt = json.dumps(rule.get("target_matchers") or rule.get("target_match") or rule.get("target_match_re") or "")
            for fam in ("PostgresDown", "PgBouncerWaiting"):
                self.assertIn(fam, tgt, "db-family alert missing from data-1 inhibition target")
            for other in ("RpoAtRisk", "WalArchiveFailing", "BackupMissed"):
                self.assertNotIn(other, tgt, "TargetDown on data-1 must not inhibit %s" % other)
            return
        self.fail("no TargetDown/data-1 inhibit rule")

    def test_escalation_address_configured(self):
        self.assertIn(ADDR["escalation"], self.text)

    def test_smtp_via_relay_without_inline_secret(self):  # 02-TRD s11.4, 07-SEC
        g = self.cfg["global"]
        self.assertTrue(str(g["smtp_smarthost"]).startswith("smtp.relay.invalid:"))
        self.assertIs(g.get("smtp_require_tls", True), True)
        self.assertEqual(g.get("smtp_from"), "alerts%sfrom.invalid" % AT)
        self.assertIn("smtp_auth_password_file", self.text)
        self.assertNotIn("smtp_auth_password:", self.text)
        self.assertNotRegex(self.text, r"(?i)password:\s*\S+")

    def test_no_foreign_saas_receivers(self):
        for bad in ("slack_configs", "pagerduty_configs", "opsgenie_configs", "victorops", "telegram", "wechat"):
            self.assertNotIn(bad, self.text)

    def test_template_has_no_phi_and_carries_runbook(self):  # AC-17.3 "rule template lint"
        self.assertTrue(AM_TMPL.exists(), "missing lims.tmpl")
        t = AM_TMPL.read_text(encoding="utf-8")
        self.assertIn("runbook_url", t)
        self.assertIn("alertname", t)
        for lbl in DROP_LABELS + ["patient", "specimen", "birth", "name"]:
            if lbl == "name":
                self.assertNotRegex(t, r"\.(Labels|CommonLabels)\.name\b")
            else:
                self.assertNotRegex(t, r"(?i)\b%s" % lbl, "template references %s" % lbl)
        self.assertNotIn("SortedPairs", t, "dumping all labels may leak PHI into e-mail")
        self.assertIn("lims", self.text, "receivers must use the lims.* templates")

    @unittest.skipUnless(shutil.which("amtool"), "amtool not on PATH (CI: amtool check-config)")
    def test_amtool_check_config(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "alertmanager.yml").write_text(self.text)
            (Path(d) / "pw").write_text("x")
            shutil.copy(AM_TMPL, Path(d) / "lims.tmpl")
            txt = self.text.replace("templates/*.tmpl", "lims.tmpl")
            (Path(d) / "alertmanager.yml").write_text(txt)
            r = subprocess.run(["amtool", "check-config", str(Path(d) / "alertmanager.yml")], capture_output=True, text=True, cwd=d)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


# ================================================================ Grafana, blackbox, ops nginx
class GrafanaBlackboxNginxTest(unittest.TestCase):
    def test_datasources_prometheus_only(self):  # 02-TRD s11.5
        files = _files(GRAF / "datasources", ("*.yml", "*.yaml", "*.j2"))
        self.assertTrue(files, "no datasource provisioning files")
        n = 0
        for p in files:
            for ds in (_load(p).get("datasources") or []):
                n += 1
                self.assertEqual(ds["type"], "prometheus", "only Prometheus datasources: no SQL path to PHI stores")
                self.assertFalse(ds.get("editable", False))
                self.assertNotRegex(ds.get("url", ""), r"^https?://(?!(localhost|127\.|prometheus|%s))" % re.escape(WG["ops-1"]))
                self.assertFalse(ds.get("password") or ds.get("secureJsonData"))
        self.assertGreaterEqual(n, 1)
        self.assertNotRegex(_ops_text(), r"(?i)type:\s*['\"]?(postgres|mysql|mssql|grafana-postgresql-datasource)")

    def test_dashboard_provider(self):
        files = _files(GRAF / "dashboards", ("*.yml", "*.yaml", "*.j2"))
        self.assertTrue(files, "no dashboard provider file")
        prov = _load(files[0])["providers"][0]
        self.assertIn("dashboards", json.dumps(prov["options"]["path"]))

    def test_grafana_hardening_env(self):  # 02-TRD s2 (no phone-home), s11.5 (anonymous off)
        t = _ops_text()
        for k in ("GF_ANALYTICS_REPORTING_ENABLED", "GF_ANALYTICS_CHECK_FOR_UPDATES", "GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES"):
            self.assertRegex(t, r"%s['\"]?\s*[:=]\s*['\"]?false" % k)
        self.assertRegex(t, r"GF_AUTH_ANONYMOUS_ENABLED['\"]?\s*[:=]\s*['\"]?false")
        self.assertRegex(t, r"GF_USERS_ALLOW_SIGN_UP['\"]?\s*[:=]\s*['\"]?false")
        self.assertNotRegex(t, r"GF_SECURITY_ADMIN_PASSWORD['\"]?\s*[:=]")  # only the __FILE form
        self.assertIn("GF_SECURITY_ADMIN_PASSWORD__FILE", t)

    def test_grafana_roles_mapped(self):  # done_when "Grafana roles"
        t = "\n".join(p.read_text(encoding="utf-8") for p in _files(ROLE_MON))
        for r in ("ops_admin", "ops_oncall", "ops_readonly"):
            self.assertIn(r, t)
        self.assertRegex(t, r"(?s)ops_readonly.{0,120}Viewer")
        self.assertRegex(t, r"(?s)ops_admin.{0,120}Admin")

    def test_blackbox_modules(self):
        d = yaml.safe_load(BLACKBOX.read_text(encoding="utf-8"))
        mods = d["modules"]
        http = [m for m in mods.values() if m.get("prober") == "http"]
        self.assertTrue(http, "http module")
        codes = {c for m in http for c in m.get("http", {}).get("valid_status_codes", [])}
        self.assertTrue({200, 302, 404} <= codes, "an http module must accept 200/302/404 (as configured per origin)")
        self.assertTrue(any(m.get("prober") == "tcp" for m in mods.values()), "tcp_connect module for forbidden ports")
        self.assertTrue(any(m.get("http", {}).get("fail_if_not_ssl") for m in http), "TLS-required http module")

    def _nginx(self):
        c = [p for p in _files(ROLE_MON) if "nginx" in p.name.lower() and p.suffix in (".j2", ".conf")]
        self.assertTrue(c, "no ops-nginx template under roles/monitoring")
        return "\n".join(_render(p) if p.suffix == ".j2" else p.read_text() for p in c)

    def test_ops_nginx_on_wg0_tls_basic_auth(self):  # 02-TRD s3.3
        t = self._nginx()
        listens = re.findall(r"(?m)^\s*listen\s+([^;]+);", t)
        self.assertTrue(listens)
        for l in listens:
            self.assertTrue(l.startswith("%s:443" % WG["ops-1"]), "listen %r must bind the wg IP :443 only" % l)
        self.assertRegex(t, r"ssl_protocols\s+TLSv1\.2\s+TLSv1\.3\s*;|ssl_protocols\s+TLSv1\.3\s*;")
        self.assertIn("ssl_certificate", t)
        self.assertRegex(t, r"auth_basic\s+[\"'\w]")
        self.assertNotRegex(t, r"auth_basic\s+off")
        self.assertRegex(t, r"auth_basic_user_file\s+/run/")  # htpasswd on tmpfs
        self.assertRegex(t, r"server_tokens\s+off")
        for up in ("grafana", "alertmanager", "prometheus", "victorialogs"):
            self.assertIn(up, t.lower(), "ops nginx must front %s" % up)

    def test_stack_publishes_nothing_on_all_interfaces(self):  # AC-01.3 spirit
        for p in _files(ROLE_MON) + _files(MON) + _files(ROOT / "infra" / "compose" / "ops"):
            if p.suffix not in (".yml", ".yaml", ".j2") or "compose" not in p.name.lower():
                continue
            for m in re.finditer(r"(?m)^\s*-\s*['\"]?(?:(\S+?):)?(\d+):(\d+)", p.read_text(encoding="utf-8")):
                self.assertTrue(m.group(1) and m.group(1) != "0.0.0.0" and not m.group(1).startswith("["),
                                "%s publishes port %s on all interfaces" % (p.name, m.group(2)))


# ================================================================ roles, internal CA, secrets, git hygiene
def _tasks(d):
    out = []

    def flat(ts):
        for t in ts or []:
            if not isinstance(t, dict):
                continue
            for k in ("block", "rescue", "always"):
                if k in t:
                    flat(t[k])
            out.append(t)
    for p in _files(d / "tasks", ("*.yml", "*.yaml")):
        flat(yaml.safe_load(p.read_text(encoding="utf-8")))
    return out


class RolesAndCaTest(unittest.TestCase):
    def test_roles_applied_to_ops_only(self):
        plays = yaml.safe_load(SITE.read_text(encoding="utf-8"))
        hit = [p for p in plays if {"monitoring", "internal_ca"} & set(map(str, p.get("roles", [])))]
        self.assertTrue(hit, "site.yml: no play applies monitoring/internal_ca")
        for p in hit:
            self.assertEqual(p["hosts"], "ops", "monitoring/internal_ca only on ops-1")
        roles = [r for p in plays for r in p.get("roles", []) if r in ("internal_ca", "monitoring")]
        self.assertLess(roles.index("internal_ca"), roles.index("monitoring"), "CA must exist before ops nginx")

    def test_alertmanager_config_rendered_on_tmpfs_no_log(self):  # 02-TRD s11.4
        ts = [t for t in _tasks(ROLE_MON) if "alertmanager.yml" in json.dumps(t)]
        self.assertTrue(ts, "no task renders alertmanager.yml")
        for t in ts:
            self.assertIn("/run/", json.dumps(t), "alertmanager.yml must land on tmpfs")
            self.assertTrue(t.get("no_log") is True, "contacts are personal data: no_log")

    def test_ca_key_tmpfs_no_log_and_removed(self):  # done_when: CA key only in the secret store
        ts = _tasks(ROLE_CA)
        keyts = [t for t in ts if re.search(r"internal_ca_key", json.dumps(t))]
        self.assertTrue(keyts, "role must take the key from secret id internal_ca_key")
        for t in keyts:
            self.assertTrue(t.get("no_log") is True, "key-handling task needs no_log")
        blob = json.dumps(ts)
        self.assertIn("/run/", blob, "CA key only on tmpfs")
        self.assertTrue(any("absent" in json.dumps(t) and re.search(r"ca[._-]?key|internal_ca_key", json.dumps(t)) for t in ts),
                        "CA key must be removed after issuing")
        self.assertNotRegex(blob, r"/(etc|var|opt|home|root)/[^\"']*ca[._-]?key")

    def test_ca_lifetimes_and_leaf_targets(self):  # 02-TRD s8.2: CA 5 y, leaf 1 y
        t = "\n".join(p.read_text(encoding="utf-8") for p in _files(ROLE_CA))
        self.assertRegex(t, r"\b1825\b|\+?5y|5\s*\*\s*365|\b60\s*months\b", "CA validity 5 years")
        self.assertRegex(t, r"\b365\b|\+?1y", "leaf validity 1 year")
        self.assertRegex(t, r"(?i)registry")
        self.assertRegex(t, r"(?i)nginx")
        self.assertRegex(t, r"(?i)subject_alt_name|subjectAltName|\bSAN\b")
        self.assertRegex(t, r"(?i)RSA\W*(3072|4096)|secp384r1|secp256r1|prime256v1|ed25519|curve")

    def test_no_private_key_material_in_git_paths(self):
        for d in (MON, ROLE_MON, ROLE_CA, ROOT / "infra" / "pki"):
            for p in _files(d):
                if p.suffix in (".pyc",):
                    continue
                # pattern split so this source file does not itself match the T-01 / gitleaks private-key scan
                self.assertNotRegex(p.read_text(encoding="utf-8", errors="ignore"), r"-----BEGIN [A-Z ]*" + "PRIVATE" + r" KEY-----", str(p))
                self.assertNotIn(p.suffix, (".key", ".pem", ".p12", ".pfx"), "key/cert artefact committed: %s" % p)

    def test_pki_readme(self):
        t = PKI.read_text(encoding="utf-8")
        for kw in ("internal_ca_key", "5 year", "1 year", "ops nginx", "registry"):
            self.assertIn(kw.lower(), t.lower(), "pki/README.md must mention %s" % kw)
        self.assertRegex(t.lower(), r"secret store|sops")
        self.assertNotRegex(t, r"-----BEGIN")

    def test_secret_ids_and_consumers(self):  # 02-TRD s8.2
        for env in ("dev", "staging", "prod"):
            d = yaml.safe_load((SCHEMAS / ("%s.secrets.schema.yaml" % env)).read_text(encoding="utf-8"))
            ents = {e["id"]: e for e in d["secrets"]}
            self.assertEqual([str(c) for c in ents["internal_ca_key"]["consumers"]], ["ops-1 internal_ca role"])
            for sid in ("alert_contacts", "tenant_ops_contacts", "alertmanager_smtp_relay"):
                self.assertIn("ops-1", " ".join(map(str, ents[sid]["consumers"])), "%s/%s" % (env, sid))

    def test_no_email_address_in_git(self):  # done_when
        paths = _files(MON) + _files(ROLE_MON) + _files(ROLE_CA) + [PKI, OPSNOTE]
        paths += _files(ROOT / "infra" / "ansible" / "inventories") + _files(ROOT / "infra" / "compose" / "ops")
        for p in paths:
            if p.suffix == ".pyc" or not p.exists():
                continue
            m = EMAIL_RE.search(p.read_text(encoding="utf-8", errors="ignore"))
            self.assertIsNone(m, "e-mail address committed in %s: %s" % (p.relative_to(ROOT), m and m.group(0)))


# ================================================================ ops-note.sh behaviour
def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


class OpsNoteTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t18-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "logger").write_bytes(b'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$FIX/logger.log"\n')

    def run_note(self, *args, user="opsuser", sudo_user=""):
        env = dict(os.environ, FIX=self.tmp.as_posix(), PATH=str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
                   USER=user, LOGNAME=user, SUDO_USER=sudo_user, LIMS_OPERATOR=user)
        r = subprocess.run([_bash(), OPSNOTE.as_posix(), *args], env=env, capture_output=True, text=True, timeout=30, cwd=str(self.tmp))
        log = self.tmp / "logger.log"
        return r, r.stdout + (log.read_text() if log.exists() else "")

    @staticmethod
    def records(text):
        out = []
        for m in re.finditer(r"\{.*\}", text):
            try:
                out.append(json.loads(m.group(0)))
            except ValueError:
                pass
        return out

    def test_not_a_stub(self):
        self.assertNotIn("not implemented", OPSNOTE.read_text(encoding="utf-8"))

    def test_writes_one_ops_audit_json_record(self):  # 04-UI-UX s5.2 / 02-TRD s8.2 (who/what/when)
        r, out = self.run_note("rotated grafana admin")
        self.assertEqual(r.returncode, 0, r.stderr)
        recs = self.records(out)
        self.assertGreaterEqual(len(recs), 1, out)
        rec = recs[0]
        self.assertEqual(rec.get("stream"), "ops_audit")
        self.assertEqual(rec.get("what"), "rotated grafana admin")
        self.assertTrue(rec.get("who"), "who missing")
        when = datetime.datetime.fromisoformat(str(rec["when"]).replace("Z", "+00:00"))
        self.assertIsNotNone(when.utcoffset())
        self.assertEqual(when.utcoffset(), datetime.timedelta(0))
        self.assertLess(abs((datetime.datetime.now(datetime.timezone.utc) - when).total_seconds()), 120)

    def test_hostile_text_stays_one_valid_json_record(self):  # injection / log forging
        evil = 'x" ,"stream":"forged"}\n{"stream":"ops_audit","what":"fake'
        r, out = self.run_note(evil)
        self.assertEqual(r.returncode, 0, r.stderr)
        recs = [x for x in self.records(out) if x.get("stream") == "ops_audit"]
        self.assertEqual(len(recs), 1, "newline/quote in text must not forge a second record: %r" % out)
        self.assertEqual(recs[0]["what"].replace("\n", "").replace("\r", ""), evil.replace("\n", ""))
        self.assertNotIn("forged", [x.get("stream") for x in recs])

    def test_non_root_cannot_forge_who_via_sudo_user(self):  # 02-TRD s8.4 who/what/when (review item 5)
        idu = subprocess.run([_bash(), "-c", "id -un; echo $EUID"], capture_output=True, text=True, timeout=30).stdout.split()
        if idu[-1] == "0":
            self.skipTest("running as root: SUDO_USER is legitimate")
        r, out = self.run_note("x", sudo_user="mallory")
        self.assertEqual(r.returncode, 0, r.stderr)
        who = [x for x in self.records(out) if x.get("stream") == "ops_audit"][0].get("who")
        self.assertNotEqual(who, "mallory", "who forged from SUDO_USER by a non-root caller")

    def test_empty_text_rejected(self):
        for args in ((), ("",), ("   ",)):
            r, out = self.run_note(*args)
            self.assertNotEqual(r.returncode, 0, "args=%r" % (args,))
            self.assertFalse(self.records(out), "nothing may be logged for empty text")

    def test_text_is_not_executed(self):
        marker = self.tmp / "pwned"
        r, _ = self.run_note('$(touch "%s") `touch "%s"`' % (marker.as_posix(), marker.as_posix()))
        self.assertFalse(marker.exists(), "command substitution in the note must not run")


if __name__ == "__main__":
    unittest.main()
