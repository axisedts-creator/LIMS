"""T-21 tests (tester role): import chunk rule files, transcribed TRD lists, module dashboards D15, module runbooks.

Covers 02-TRD s11.3 (intake table, "Imported rules", module-metric registry, annotation lint), s11.2 item 2 (scrape drop
list), s11.4 (routing), s12.4 (CI job alert-import-drift), 04-UI-UX s3 D15, s4 (runbooks + entry template), s6 (intake),
06-PLAN row T-21, AC-17.2, 07-SEC (no PHI in alerts, fail closed). Done when (T-21): each row of the s11.3 intake table is
implemented with the owner's threshold; the module-metric registry is excluded from the scrape drop list.

Chunk TRD "Alert rules for C1" tables are PARSED FROM spec/chunks/C*/02-TRD.md at test time (not copied by hand): every
row that carries a PromQL expression must exist in infra with expr and `for` verbatim and the mapped severity.
The chunk-owned source files (services/**/...rules.yml) do not exist in this lane, so the imported files are the TRD
transcription; import-rules.sh overwrites them when the source exists and `--check` (job alert-import-drift) proves it.

CONTRACTS where the spec is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ci/import-rules.sh [--check]. Env LIMS_IMPORT_SRC_ROOT (default: repo root, resolved from the script path, so
   cwd does not matter) and LIMS_IMPORT_OUT_DIR (default infra/monitoring/rules/imported). Fixed source map (02-TRD s11.3):
   catalog=services/api/src/modules/catalog/ops/alerts.yaml; billing=services/worker/src/jobs/billing/alerts/*.yaml;
   frontdesk=.../frontdesk/alerts/*.yaml; lab=.../jobs/lab/ops/lab.rules.yml; reporting=.../reporting/alerts/reporting.rules.yaml;
   instruments=.../instruments/alerts/instruments.rules.yml; analytics=.../analytics/ops/analytics.rules.yml;
   quality=.../quality/ops/quality.rules.yml; inventory=.../inventory/ops/inventory.rules.yml;
   smartreport=.../smartreport/ops/smartreport.rules.yml. Output <OUT>/<module>.rules.yml. A missing source is skipped
   (exit 0, nothing written, existing imported file untouched). Per rule it adds ONLY labels.severity (if missing,
   value page|warn|info), labels.team (non-empty), annotations.runbook_url = infra/runbooks/<module>.md#<alert lower-case>
   and optionally labels.receiver; alert/expr/for/other labels/annotations stay verbatim, nothing is invented (no `for`
   added). Without --check it writes (idempotent, source never modified); with --check it writes nothing and exits
   non-zero (naming the module) when any present source's expected output differs from the committed file or the
   committed file is missing. Fail closed (non-zero, existing outputs untouched): alert name not [A-Za-z][A-Za-z0-9_]*,
   missing alert/expr, severity not page|warn|info, a drop-list label (patient_id|order_id|...) anywhere in a rule,
   an e-mail address in a rule, unknown argument.
 * Files: rules/imported/<module>.rules.yml for catalog, billing, frontdesk, lab, reporting, instruments, analytics,
   quality, inventory, smartreport; transcribed rules/{core,identity,micro,anatomic,partners,payments}.rules.yml.
   Every alert: severity in page|warn|info, labels.team non-empty, annotations.summary, annotations.runbook_url =
   infra/runbooks/<file stem>.md#<alert lower-case>, no notify_tenant="true" (tenant mail is BridgeAgentOfflineLong's).
   C15's HeldForReview rule carries team="finance" (T-18 routes that team to finance-oncall-email).
 * promtool: rules/tests/<stem>.test.yml for every file above except instruments (T-20): rule_files names the file,
   >= 1 firing and >= 1 not-firing case per alert, `for` boundary for alerts with `for` > 0, exp_labels carry the rule's
   severity and team.
 * D15: grafana/dashboards/D15-<stem>.json for each stem above except instruments (D12 covers it): Prometheus datasource only,
   title contains "D15", every non-text panel has a description naming the owning chunk (Cnn) and a metric source,
   at least one panel queries a metric used by that module's rules, tenant_id variable only if a query carries tenant_id.
 * Runbooks: infra/runbooks/<stem>.md for each stem above (instruments.md also covers the six BridgeAgent* alerts):
   one `## <AlertName>` section per alert (slug = lower-case name) with Severity:, Owner:, **Means:**, **Check first:**,
   **Fix:**, **Escalate when:**, **Close-out:** (04-UI-UX s4.2) and Severity equal to the rule's.
Stdlib + jinja2 + PyYAML. Missing file = FAIL. `promtool` runs only when on PATH (hard FAIL if CI=true and absent).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t21_*.py" -v
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

from test_t18_monitoring import AM_J2, DROP_LABELS, MON, PROM_J2, ROOT, TENANT1, _bash, _render, _route, _secs

RULES = MON / "rules"
IMP = RULES / "imported"
PT = RULES / "tests"
DASH = MON / "grafana" / "dashboards"
RUNB = ROOT / "infra" / "runbooks"
SCRIPT = ROOT / "infra" / "ci" / "import-rules.sh"
CHUNKS = ROOT / "spec" / "chunks"

IMPORTED = ["catalog", "billing", "frontdesk", "lab", "reporting", "instruments", "analytics", "quality", "inventory",
            "smartreport"]
TRANSCRIBED = ["core", "identity", "micro", "anatomic", "partners", "payments"]
SEVS = {"page", "warn", "info"}
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
PASCAL = re.compile(r"^[A-Z][A-Za-z0-9]+$")


def _n(s):
    return re.sub(r"\s+", "", str(s))


def _dur(x):
    x = str(x if x is not None else "0").strip()
    return 0 if x in ("0", "") else _secs(x)


def _path(stem):
    return (IMP if stem in IMPORTED else RULES) / ("%s.rules.yml" % stem)


def _rules(path):
    assert path.exists(), "missing %s" % path.relative_to(ROOT)
    d = yaml.safe_load(path.read_text(encoding="utf-8"))
    out = {}
    for g in d["groups"]:
        for r in g["rules"]:
            if "alert" in r:
                assert r["alert"] not in out, "duplicate alert %s in %s" % (r["alert"], path.name)
                out[r["alert"]] = r
    return out


def _union(stems):
    out = {}
    for s in stems:
        out.update(_rules(_path(s)))
    return out


def _slug(h):
    h = re.sub(r"[`*_]", "", h).strip().lower()  # markdown emphasis chars do not survive in anchors
    return re.sub(r"\s", "-", re.sub(r"[^\w\s-]", "", h))


# ---------------------------------------------------------------- TRD "Alert rules for C1" table parser
def _split_row(line):
    s = line.strip()
    s = s[1:] if s.startswith("|") else s
    s = s[:-1] if s.endswith("|") and not s.endswith("\\|") else s
    cells, cur, tick, prev = [], [], False, ""
    for ch in s:
        if ch == "`":
            tick = not tick
        if ch == "|" and not tick and prev != "\\":
            cells.append("".join(cur).strip())
            cur = []
        else:
            cur.append(ch)
        prev = ch
    cells.append("".join(cur).strip())
    return cells


SEV_MAP = {"page": {"page"}, "warn": {"warn"}, "info": {"info"}, "warning": {"warn"}, "critical": {"page"},
           "ticket": {"warn", "info"}}


def trd_rows(chunk_dir):
    """-> list of dict(name, expr, for, sev(set)) for table rows that carry a PromQL expression with a lims_ metric."""
    lines = (CHUNKS / chunk_dir / "02-TRD.md").read_text(encoding="utf-8").splitlines()
    start = next(i for i, l in enumerate(lines)
                 if "Alert rules for C1" in l and (l.startswith("####") or l.startswith("**Alert rules")
                                                   or l.startswith("Alert rules for C1")))
    i = next(j for j in range(start, len(lines)) if lines[j].lstrip().startswith("|"))
    header = [h.lower() for h in _split_row(lines[i])]
    ix = {k: next(n for n, h in enumerate(header) if h.startswith(k) or k in h) for k in ("expr", "sever")}
    ix["for"] = header.index("for")
    rows = []
    for l in lines[i + 2:]:
        if not l.lstrip().startswith("|"):
            break
        c = _split_row(l)
        assert len(c) == len(header), "%s: cannot parse TRD row %r" % (chunk_dir, l[:80])
        m = re.search(r"`([^`]+)`", c[ix["expr"]])
        before = c[ix["expr"]][:m.start()] if m else ""
        if not m or "lims_" not in m.group(1) or "T33" in before:
            continue
        sev = re.split(r"[\s(]", c[ix["sever"]].strip().lower())[0]
        nm = re.match(r"`([^`]+)`", c[0])
        rows.append({"name": nm.group(1) if nm else c[0].strip("* "), "expr": m.group(1).replace("\\|", "|"),
                     "for": c[ix["for"]].split()[0], "sev": SEV_MAP[sev]})
    return rows


def _check_rows(tc, chunk, stems, exact_names):
    rules = _union(stems)
    rows = trd_rows(chunk)
    tc.assertGreaterEqual(len(rows), 4, "%s: TRD table parse found only %d PromQL rows" % (chunk, len(rows)))
    by_expr = {_n(r["expr"]): (n, r) for n, r in rules.items()}
    for row in rows:
        if PASCAL.match(row["name"]):
            tc.assertIn(row["name"], rules, "%s: alert %s missing" % (chunk, row["name"]))
            n, r = row["name"], rules[row["name"]]
        else:
            tc.assertIn(_n(row["expr"]), by_expr, "%s: no rule with expr of TRD row %r" % (chunk, row["name"]))
            n, r = by_expr[_n(row["expr"])]
        tc.assertEqual(_n(r["expr"]), _n(row["expr"]), "%s: expr not verbatim" % n)
        tc.assertEqual(_dur(r.get("for")), _dur(row["for"]), "%s: for" % n)
        tc.assertIn(r["labels"].get("severity"), row["sev"], "%s: severity" % n)
    if exact_names:
        tc.assertEqual(set(rules), {r["name"] for r in rows}, "%s: rules differ from the TRD table (invented/missing)" % chunk)


# ================================================================ imported chunk rule files (transcribed from TRD tables)
class ImportedTrdRowsTest(unittest.TestCase):
    def test_c3_catalog(self):  # CR-C3-009: 6 rules
        _check_rows(self, "C3-catalog-pricing", ["catalog"], True)

    def test_c4_billing_and_frontdesk(self):  # DB-rule rows (no PromQL) are out of scope; rest verbatim
        _check_rows(self, "C4-frontdesk-billing", ["billing", "frontdesk"], False)

    def test_c5_lab(self):  # CR-C5-010: 5 rules
        _check_rows(self, "C5-lab-workflow", ["lab"], True)

    def test_c6_reporting(self):  # T33 rows may be absent until the metric exists
        _check_rows(self, "C6-reporting-delivery", ["reporting"], False)

    def test_c8_analytics(self):  # CR-C8-015: 5 rules
        _check_rows(self, "C8-analytics-mis", ["analytics"], True)

    def test_c9_quality(self):  # CR-C9-008: 7 rules
        _check_rows(self, "C9-quality-engine", ["quality"], True)

    def test_c12_inventory(self):  # CR-C12-011: 4 rules
        _check_rows(self, "C12-inventory", ["inventory"], True)

    def test_c14_smartreport(self):  # CR-C14-010: 6 rules
        _check_rows(self, "C14-smart-report", ["smartreport"], True)

    def test_c2_identity_transcribed(self):  # intake row C2 -> rules/identity.rules.yml; 10 alerts
        _check_rows(self, "C2-identity-admin", ["identity"], True)

    def test_c15_payments_transcribed(self):  # intake row C15 -> rules/payments.rules.yml; 9 alerts
        _check_rows(self, "C15-payment-gateways", ["payments"], True)

    def test_c15_held_for_review_goes_to_finance(self):  # s11.3 C15 row + s11.4 finance-oncall-email
        r = _rules(_path("payments"))["PaymentsHeldForReviewStale"]
        self.assertEqual(r["labels"].get("team"), "finance")
        self.assertEqual(r["labels"].get("severity"), "warn")


# ================================================================ transcribed TRD lists (C0, C10, C11, C13)
def _find(rules, *subs, sev=None):
    out = [(n, r) for n, r in rules.items() if all(s in _n(r["expr"]) for s in map(_n, subs))]
    if sev:
        out = [(n, r) for n, r in out if r["labels"].get("severity") == sev]
    return out


class CoreRulesTest(unittest.TestCase):  # C0 02-TRD s13 via 02-TRD s11.3 intake row
    @classmethod
    def setUpClass(cls):
        cls.r = _rules(_path("core"))

    def test_seven_rules_rate_limit_backend_not_duplicated(self):  # ValkeyDown (runtime.rules) covers the 8th item
        self.assertEqual(len(self.r), 7, sorted(self.r))
        self.assertFalse(_find(self.r, "ratelimit"))

    def test_core_retention_purge_capped_d200(self):
        r = self.r.get("CoreRetentionPurgeCapped")
        self.assertIsNotNone(r, "CoreRetentionPurgeCapped missing")
        self.assertEqual(_n(r["expr"]), _n("sum by (table) (increase(lims_core_retention_purge_capped_total[26h])) > 0"))
        self.assertEqual(_dur(r["for"]), 72 * 3600)
        self.assertEqual(r["labels"]["severity"], "warn")

    def test_dead_letter_any_task_pages(self):
        hit = _find(self.r, "lims_core_dead_letters_total", "> 0", sev="page")
        self.assertTrue(hit, "no page rule on dead letters > 0")
        self.assertNotIn("task", _n(hit[0][1]["expr"]), "dead letter of ANY task must alert")

    def test_fake_ports_only_staging_prod_pages(self):
        hit = _find(self.r, "lims_core_fake_ports_active", "> 0", sev="page")
        self.assertTrue(hit)
        e = hit[0][1]["expr"]
        self.assertIn("staging", e)
        self.assertIn("prod", e)

    def test_fanout_lag_p95_over_10s_for_5m_warn(self):
        hit = _find(self.r, "histogram_quantile(0.95", "lims_core_event_fanout_lag_seconds_bucket", "> 10", sev="warn")
        self.assertTrue(hit)
        self.assertEqual(_dur(hit[0][1]["for"]), 300)

    def test_rls_denied_5x_7d_baseline_pages(self):
        hit = _find(self.r, "lims_rls_denied_total", "7d", sev="page")
        self.assertTrue(hit)
        self.assertRegex(hit[0][1]["expr"], r"\b5\s*\*|\*\s*5\b")

    def test_auth_alg_and_authz_not_asserted_page(self):
        self.assertTrue(_find(self.r, 'lims_core_auth_failures_total{reason="alg"}', "> 0", sev="page"))
        self.assertTrue(_find(self.r, "lims_core_authz_not_asserted_total", "> 0", sev="page"))


class MicroAnatomicPartnersRulesTest(unittest.TestCase):
    def test_micro_five_rules(self):  # C10 hand-off
        r = _rules(_path("micro"))
        self.assertEqual(len(r), 5, sorted(r))
        a = _find(r, "lims_micro_instrument_records_open", "pending_match|needs_mapping|conflict", "> 50")
        self.assertTrue(a)
        self.assertEqual(_dur(a[0][1]["for"]), 24 * 3600)
        self.assertTrue(_find(r, "lims_core_dead_letters_total", "evt", "micro", "> 0"))
        self.assertTrue(_find(r, "lims_core_dead_letters_total", "micro.breakpoint_import_validate")
                        or _find(r, "lims_core_dead_letters_total", "breakpoint_import_validate"))
        f = _find(r, 'lims_micro_submit_failures_total{error_code="common.internal"}', "rate(", "> 0")
        self.assertTrue(f)
        self.assertEqual(_dur(f[0][1]["for"]), 900)
        self.assertTrue(_find(r, "increase(lims_micro_unmapped_received_total[1h])", "> 0"))

    def test_anatomic_four_rules(self):  # C11
        r = _rules(_path("anatomic"))
        self.assertEqual(len(r), 4, sorted(r))
        dl = _find(r, "lims_core_dead_letters_total", "evt", "anatomic", "> 0", sev="warn")
        self.assertTrue(dl)
        q = _find(r, 'lims_anatomic_image_processing_total{outcome="quarantined"}', "[1h]", "> 5", sev="warn")
        self.assertTrue(q)
        s = _find(r, "lims_anatomic_submit_failures_total", "0.1", sev="warn")
        self.assertTrue(s)
        self.assertEqual(_dur(s[0][1]["for"]), 600)
        lk = _find(r, "lims_anatomic_lookup_total", "not_found", "50")
        self.assertTrue(lk, "lookup not_found > 50/min (REQ-SEC-045) missing")
        for n, x in lk:  # per-user label is on the s11.2 drop list, so the rule may not select/group by user_id
            self.assertNotRegex(x["expr"], r"\buser_id\b", n)

    def test_partners_six_rows(self):  # C13 02-TRD s13 alert table (6 rows)
        r = _rules(_path("partners"))
        self.assertGreaterEqual(len(r), 6, sorted(r))
        self.assertTrue(_find(r, "lims_core_dead_letters_total", "partners"))
        for m in ("lims_partners_line_conversions_total", "lims_partners_report_downloads_total",
                  "lims_partners_projection_lag_seconds", "lims_partners_events_consumed_total"):
            self.assertTrue(_find(r, m), "no partners rule on %s" % m)
        self.assertTrue(_find(r, "failed_infra", "5"))
        self.assertTrue(_find(r, "mismatch", "> 0"))
        self.assertTrue(_find(r, "denied", "20"))


# ================================================================ lint, routing, security over every T-21 rule file
ALL_STEMS = IMPORTED + TRANSCRIBED


class RuleLintTest(unittest.TestCase):
    def test_every_file_exists_and_parses(self):
        for s in ALL_STEMS:
            self.assertTrue(_rules(_path(s)), s)
        extra = {p.stem.replace(".rules", "") for p in IMP.glob("*.rules.yml")} - set(IMPORTED)
        self.assertFalse(extra, "imported file without an intake row: %s" % extra)

    def test_annotation_severity_team_runbook_lint(self):  # 02-TRD s11.3 last paragraph (AC-17.2 "runbook link")
        for s in ALL_STEMS:
            for n, r in _rules(_path(s)).items():
                a, lab = r.get("annotations") or {}, r.get("labels") or {}
                self.assertTrue(str(a.get("summary", "")).strip(), "%s/%s summary" % (s, n))
                self.assertEqual(str(a.get("runbook_url", "")).lower(), "infra/runbooks/%s.md#%s" % (s, n.lower()), "%s/%s" % (s, n))
                self.assertIn(lab.get("severity"), SEVS, "%s/%s severity" % (s, n))
                self.assertTrue(str(lab.get("team", "")).strip(), "%s/%s team" % (s, n))
                self.assertNotEqual(lab.get("notify_tenant"), "true", "%s/%s notify_tenant" % (s, n))
                self.assertIn("expr", r)

    def test_no_phi_labels_no_email_in_rules(self):  # 02-TRD s11.2 item 2 drop list; 07-SEC no PHI/personal data
        for s in ALL_STEMS:
            text = _path(s).read_text(encoding="utf-8")
            self.assertIsNone(EMAIL_RE.search(text), "%s: e-mail address" % s)
            for n, r in _rules(_path(s)).items():
                # arbiter ruling C1.T-21-ruling.md: drop list bans label NAMES (02-TRD s11.2 item 2, :912), not values
                # such as the receiver `oncall-email`.
                self.assertFalse(set(r.get("labels", {})) & set(DROP_LABELS), "%s/%s drop-list label key" % (s, n))
                tmpl = json.dumps([r.get("expr"), r.get("annotations", {})])
                for lbl in DROP_LABELS:
                    self.assertNotRegex(tmpl, r"\$labels\.%s\b" % lbl, "%s/%s templates drop-list label %s" % (s, n, lbl))

    def test_routing_page_oncall_warn_digest_finance(self):  # s11.4 against the real T-18 Alertmanager template
        cfg = yaml.safe_load(_render(AM_J2))
        for s in ALL_STEMS:
            for n, r in _rules(_path(s)).items():
                rcv = [h[0] for h in _route(cfg, dict(r["labels"], alertname=n, tenant_id=TENANT1))]
                sev = r["labels"]["severity"]
                if r["labels"].get("team") == "finance":
                    self.assertIn("finance-oncall-email", rcv, "%s/%s" % (s, n))
                elif sev == "page":
                    self.assertIn("oncall-email", rcv, "%s/%s" % (s, n))
                elif sev == "warn":
                    self.assertIn("ops-digest-email", rcv, "%s/%s" % (s, n))
                    self.assertNotIn("oncall-email", rcv, "%s/%s" % (s, n))
                else:
                    self.assertNotIn("oncall-email", rcv, "%s/%s" % (s, n))

    @unittest.skipUnless(shutil.which("promtool"), "promtool not on PATH (CI: promtool check rules)")
    def test_promtool_check_rules(self):
        files = [str(_path(s)) for s in ALL_STEMS]
        r = subprocess.run(["promtool", "check", "rules", *files], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


# ================================================================ promtool unit tests per rule (AC-17.2 "covers each")
class PromtoolFilesTest(unittest.TestCase):
    STEMS = [s for s in ALL_STEMS if s != "instruments"]  # instruments: T-20's rules/tests/instruments.test.yml

    def doc(self, s):
        p = PT / ("%s.test.yml" % s)
        self.assertTrue(p.exists(), "missing rules/tests/%s.test.yml" % s)
        return p, yaml.safe_load(p.read_text(encoding="utf-8"))

    def test_each_file_has_a_test_file_naming_it(self):
        for s in self.STEMS:
            p, d = self.doc(s)
            self.assertIn(_path(s).resolve(), [(p.parent / f).resolve() for f in d["rule_files"]], s)
            self.assertTrue(d.get("evaluation_interval"), s)

    def test_every_alert_firing_and_not_firing_with_matching_labels(self):
        for s in self.STEMS:
            _, d = self.doc(s)
            exp = [e for c in d["tests"] for e in c.get("alert_rule_test", [])]
            for n, r in _rules(_path(s)).items():
                es = [e for e in exp if e["alertname"] == n]
                firing = [e for e in es if e.get("exp_alerts")]
                self.assertTrue(firing, "%s/%s: no firing case" % (s, n))
                self.assertTrue([e for e in es if not e.get("exp_alerts")], "%s/%s: no not-firing case" % (s, n))
                for e in firing:
                    for a in e["exp_alerts"]:
                        lab = a.get("exp_labels", {})
                        self.assertEqual(lab.get("severity"), r["labels"]["severity"], "%s/%s severity in expectation" % (s, n))
                        self.assertEqual(lab.get("team"), r["labels"]["team"], "%s/%s team in expectation" % (s, n))
                        self.assertFalse(set(lab) & set(DROP_LABELS), "%s/%s" % (s, n))

    def test_exp_annotations_equal_rule_annotations(self):
        # promtool compares annotations exactly: a missing exp_annotations means "expected empty" and fails every firing
        # case (review item 1). Also covers `instruments` (review round 3, item 2): the imported summaries are generic
        # ("<Alert> is firing"); T-20's hand-written BridgeAgent* rules (rules/instruments.rules.yml) are merged in.
        # Annotation values containing `{{` are templated (promtool expands them) so only those keys are skipped.
        for s in ALL_STEMS:
            _, d = self.doc(s)
            rules = dict(_rules(_path(s)))
            if s == "instruments":
                rules.update(_rules(RULES / "instruments.rules.yml"))
            for c in d["tests"]:
                for e in c.get("alert_rule_test", []):
                    for a in e.get("exp_alerts") or []:
                        ann = rules[e["alertname"]]["annotations"]
                        want = {k: " ".join(str(v).split()) for k, v in ann.items() if "{{" not in str(v)}
                        got = a.get("exp_annotations") or {}
                        self.assertEqual({k: got.get(k) for k in want}, want,
                                         "%s/%s exp_annotations != rule annotations" % (s, e["alertname"]))
                        self.assertTrue(set(got) >= set(ann), "%s/%s exp_annotations missing keys" % (s, e["alertname"]))

    def test_for_boundary_covered(self):  # not firing before `for`, firing at/after it
        for s in self.STEMS:
            _, d = self.doc(s)
            exp = [e for c in d["tests"] for e in c.get("alert_rule_test", [])]
            for n, r in _rules(_path(s)).items():
                f = _dur(r.get("for"))
                if f <= 0:
                    continue
                es = [e for e in exp if e["alertname"] == n]
                self.assertTrue([e for e in es if not e.get("exp_alerts") and 0 < _dur(e["eval_time"]) < f],
                                "%s/%s: no 'pending before %s' case" % (s, n, r["for"]))
                self.assertTrue([e for e in es if e.get("exp_alerts") and _dur(e["eval_time"]) >= f],
                                "%s/%s: no 'firing at/after %s' case" % (s, n, r["for"]))

    def test_synthetic_series_only(self):  # CLAUDE.md: synthetic data, no e-mail, no PHI-class labels
        for s in self.STEMS:
            blob = (PT / ("%s.test.yml" % s)).read_text(encoding="utf-8")
            self.assertIsNone(EMAIL_RE.search(blob), s)
            for lbl in DROP_LABELS:  # ruling: series label KEYS only (`lbl=` / `lbl:`), not bare words
                self.assertNotRegex(blob, r"\b%s\s*[=:]" % lbl, "%s: %s" % (s, lbl))

    def test_promtool_test_rules(self):
        if not shutil.which("promtool"):
            if os.environ.get("CI") == "true":
                self.fail("promtool missing in CI")
            self.skipTest("promtool not on PATH (CI: promtool test rules)")
        for s in self.STEMS:
            p = PT / ("%s.test.yml" % s)
            r = subprocess.run(["promtool", "test", "rules", p.name], capture_output=True, text=True, cwd=str(PT))
            self.assertEqual(r.returncode, 0, "%s\n%s%s" % (s, r.stdout, r.stderr))


# ================================================================ dashboards D15
class DashboardD15Test(unittest.TestCase):
    STEMS = [s for s in ALL_STEMS if s != "instruments"]

    def load(self, s):
        p = DASH / ("D15-%s.json" % s)
        self.assertTrue(p.exists(), "missing grafana/dashboards/D15-%s.json" % s)
        return json.loads(p.read_text(encoding="utf-8"))

    @staticmethod
    def panels(d):
        for p in d.get("panels", []):
            yield p
            for q in p.get("panels", []):
                yield q

    def test_one_per_module_prometheus_only_with_descriptions(self):  # 04-UI-UX s3 panel rules
        for s in self.STEMS:
            d = self.load(s)
            self.assertIn("D15", d["title"], s)
            self.assertTrue(d.get("uid"), s)
            data = [p for p in self.panels(d) if p.get("type") != "text"]
            self.assertTrue(data, "%s: no data panel" % s)
            for p in data:
                self.assertTrue(re.search(r"\bC\d+\b", p.get("description", "")), "%s/%s: description must name the owning chunk" % (s, p.get("title")))
                self.assertTrue(re.search(r"lims_\w+", p.get("description", "") + json.dumps(p.get("targets"))), s)
                self.assertTrue(p.get("targets"), "%s/%s" % (s, p.get("title")))
                ds = json.dumps(p.get("datasource", {}))
                self.assertIn("prometheus", ds.lower(), "%s/%s: Prometheus datasource only" % (s, p.get("title")))
                self.assertNotRegex(json.dumps(p.get("targets")), r'"(rawSql|rawQuery|sql)"', "%s: no direct SQL" % s)
        blob = " ".join((DASH / ("D15-%s.json" % s)).read_text(encoding="utf-8").lower() for s in self.STEMS)
        for bad in ("postgres", "mysql", "loki", "victorialogs"):
            self.assertNotRegex(blob, r'"type"\s*:\s*"%s"' % bad)

    def test_queries_use_module_rule_metrics(self):
        for s in self.STEMS:
            used = {re.sub(r"_(bucket|sum|count)$", "", m) for r in _rules(_path(s)).values() for m in re.findall(r"\blims_\w+", r["expr"])}
            exprs = " ".join(t.get("expr", "") for p in self.panels(self.load(s)) for t in p.get("targets", []))
            have = {re.sub(r"_(bucket|sum|count)$", "", m) for m in re.findall(r"\blims_\w+", exprs)}
            self.assertTrue(used & have, "%s: no panel queries a metric of the module's alert rules" % s)

    def test_no_phi_labels_in_queries_and_tenant_variable_only_if_label_exists(self):
        for s in self.STEMS:
            d = self.load(s)
            text = json.dumps(d)
            for lbl in DROP_LABELS:
                self.assertNotRegex(text, r"\b%s\b" % lbl, "%s: %s" % (s, lbl))
            names = [v.get("name") for v in d.get("templating", {}).get("list", [])]
            if "tenant_id" in names:
                exprs = " ".join(t.get("expr", "") for p in self.panels(d) for t in p.get("targets", []))
                self.assertIn("tenant_id", exprs.replace("$tenant_id", ""), "%s: tenant_id variable but no tenant_id label queried" % s)

    def test_d12_and_d15_do_not_collide(self):
        files = [p for p in DASH.glob("*.json")]
        uids = [json.loads(p.read_text(encoding="utf-8")).get("uid") for p in files]
        self.assertEqual(len(uids), len(set(uids)), "duplicate dashboard uid")


# ================================================================ runbooks
class RunbooksTest(unittest.TestCase):
    TEMPLATE = ("Severity:", "Owner:", "**Means:**", "**Check first:**", "**Fix:**", "**Escalate when:**", "**Close-out:**")

    @staticmethod
    def sections(text):
        parts = re.split(r"(?m)^## +", text)[1:]
        return {_slug(p.split("\n", 1)[0]): p for p in parts}

    def rules_for(self, s):
        r = _rules(_path(s))
        if s == "instruments":
            r.update(_rules(RULES / "instruments.rules.yml"))
        return r

    def test_one_runbook_per_module_with_anchor_per_alert(self):  # AC-17.2 "runbook link"; 04-UI-UX s4.1 `<module>.md`
        for s in ALL_STEMS:
            p = RUNB / ("%s.md" % s)
            self.assertTrue(p.exists(), "missing infra/runbooks/%s.md" % s)
            sec = self.sections(p.read_text(encoding="utf-8"))
            for n in self.rules_for(s):
                self.assertIn(n.lower(), sec, "%s.md: no '## %s' section (anchor #%s)" % (s, n, n.lower()))

    def test_entry_template_and_severity_match(self):  # 04-UI-UX s4.2
        for s in ALL_STEMS:
            sec = self.sections((RUNB / ("%s.md" % s)).read_text(encoding="utf-8")) if (RUNB / ("%s.md" % s)).exists() else {}
            for n, r in self.rules_for(s).items():
                body = sec.get(n.lower(), "")
                for field in self.TEMPLATE:
                    self.assertIn(field, body, "%s.md#%s lacks %s" % (s, n.lower(), field))
                m = re.search(r"Severity:\s*\**\s*(page|warn|info)", body)
                self.assertTrue(m, "%s#%s: Severity line" % (s, n))
                self.assertEqual(m.group(1), r["labels"]["severity"], "%s#%s severity differs from the rule" % (s, n))

    def test_runbooks_hold_no_email_addresses_or_secrets(self):  # addresses live in secret ids only (s11.4, 07-SEC)
        for p in RUNB.glob("*.md") if RUNB.exists() else []:
            t = p.read_text(encoding="utf-8")
            self.assertIsNone(EMAIL_RE.search(t), "%s: e-mail address" % p.name)
            self.assertNotRegex(t, r"(?i)(password|secret|token)\s*[:=]\s*\S{8,}", p.name)


# ================================================================ module-metric registry vs scrape drop list
REGISTRY = {  # 02-TRD s11.3 "Module-metric registry" (+ C7 lims_instruments_* set from s11.2 item 3 / C7 intake row)
    "lims_core_retention_purge_capped_total": ["table"],
    "lims_inventory_unresolved_oldest_age_seconds": ["tenant_id"],
    "lims_micro_unmapped_received_total": [],
    "lims_instruments_agent_state": ["tenant_id", "centre_id", "agent_id", "state"],
    "lims_instruments_agent_last_heartbeat_timestamp_seconds": ["tenant_id", "centre_id", "agent_id"],
    "lims_instruments_agent_queue_depth": ["tenant_id", "centre_id", "agent_id"],
    "lims_instruments_agent_clock_offset_seconds": ["tenant_id", "centre_id", "agent_id"],
    "lims_instruments_agent_silent_instruments": ["tenant_id", "centre_id", "agent_id"],
    "lims_instruments_agent_info": ["tenant_id", "centre_id", "agent_id", "agent_version"],
    "lims_instruments_agent_update_failures_total": [],
    "lims_instruments_agent_config_rejections_total": [],
    "lims_instruments_device_auth_failures_total": [],
    "lims_instruments_ingest_messages_total": ["outcome"],
    "lims_instruments_attachment_scans_total": ["outcome"],
    "lims_instruments_ingest_batch_duration_seconds_bucket": ["le"],
}
MODULE_JOBS = ("api-a", "api-b", "worker-a", "worker-b")


def _rule_metrics_and_labels():
    """Every lims_ metric named in a T-21 rule file + the labels the rules select or group by."""
    out = dict(REGISTRY)
    for s in ALL_STEMS:
        for r in _rules(_path(s)).values():
            e = str(r["expr"])
            labels = set(re.findall(r"([A-Za-z_]\w*)\s*(?:=~|!~|!=|=)\s*\"", e))
            for grp in re.findall(r"\b(?:by|without)\s*\(([^)]*)\)", e):
                labels |= {x.strip() for x in grp.split(",") if x.strip()}
            labels -= {"__name__"}
            for m in re.findall(r"\blims_\w+", e):
                out.setdefault(m, [])
                out[m] = sorted(set(out[m]) | (labels if m.startswith("lims_") else set()))
    return out


def _survives(job_cfg, metric, labels):
    """Apply a job's metric_relabel_configs (Prometheus semantics subset) to one synthetic sample; True if it survives with all labels."""
    sample = dict({l: "x" for l in labels}, __name__=metric)
    for c in job_cfg.get("metric_relabel_configs", []) or []:
        act, rx = c.get("action", "replace"), c.get("regex", "(.*)")
        full = lambda v: re.fullmatch(rx, v) is not None
        if act == "labeldrop":
            if any(full(k) for k in sample if k != "__name__"):
                return False
        elif act == "labelkeep":
            if any(not full(k) for k in sample if k != "__name__"):
                return False
        elif act in ("drop", "keep"):
            joined = c.get("separator", ";").join(sample.get(k, "") for k in c.get("source_labels", []))
            if full(joined) == (act == "drop"):
                return False
        elif act in ("replace", "labelmap", "lowercase", "uppercase", "hashmod", "keepequal", "dropequal"):
            pass
    return True


class MetricRegistryNotDroppedTest(unittest.TestCase):  # done_when: registry excluded from the scrape drop list
    @classmethod
    def setUpClass(cls):
        cfg = yaml.safe_load(_render(PROM_J2))
        cls.jobs = {j["job_name"]: j for j in cfg["scrape_configs"]}

    def test_registry_metrics_and_labels_survive_module_jobs(self):
        for job in MODULE_JOBS:
            self.assertIn(job, self.jobs)
            for metric, labels in REGISTRY.items():
                self.assertTrue(_survives(self.jobs[job], metric, labels), "%s: %s{%s} dropped at scrape" % (job, metric, labels))

    def test_every_metric_and_label_used_by_t21_rules_survives(self):  # "every metric named in a file of the table above"
        used = _rule_metrics_and_labels()
        self.assertGreater(len(used), 40, "rule metric extraction found too little: %d" % len(used))
        for job in MODULE_JOBS:
            for metric, labels in used.items():
                if metric.startswith("lims_ops_"):
                    continue  # textfile metrics of node_exporter, not module jobs
                self.assertTrue(_survives(self.jobs[job], metric, labels), "%s: %s{%s} dropped at scrape" % (job, metric, labels))

    def test_drop_list_still_drops_phi_labels(self):  # the exclusion must not weaken s11.2 item 2
        for job in MODULE_JOBS:
            for lbl in DROP_LABELS:
                self.assertFalse(_survives(self.jobs[job], "lims_core_dead_letters_total", [lbl]), "%s: %s survives" % (job, lbl))


# ================================================================ import-rules.sh (alert-import-drift)
SRC_MAP = {  # module -> (relative source path(s))
    "lab": ["services/worker/src/jobs/lab/ops/lab.rules.yml"],
    "catalog": ["services/api/src/modules/catalog/ops/alerts.yaml"],
    "billing": ["services/worker/src/jobs/billing/alerts/a.yaml", "services/worker/src/jobs/billing/alerts/b.yaml"],
    "frontdesk": ["services/worker/src/jobs/frontdesk/alerts/x.yaml"],
}
LAB_SRC = """groups:
  - name: lab
    rules:
      - alert: LabCriticalUnnotified
        expr: max by (tenant_id) (lims_lab_critical_unnotified_oldest_age_seconds) > 1800
        for: 1m
        labels:
          severity: page
          custom: keepme
        annotations:
          summary: "Oldest critical value unnotified for {{ $labels.tenant_id }}"
      - alert: LabNoSeverity
        expr: increase(lims_lab_barcode_alloc_failures_total[5m]) > 0
        annotations:
          summary: "Barcode allocation failing"
"""


def _rule(alert, expr="increase(lims_x_total[5m]) > 0", **kw):
    r = {"alert": alert, "expr": expr, "for": "0m", "labels": {"severity": "warn"}, "annotations": {"summary": "x"}}
    r.update(kw)
    return {"groups": [{"name": "g", "rules": [r]}]}


class ImportScriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t21-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src, self.out = self.tmp / "src", self.tmp / "out"
        self.out.mkdir()

    def put(self, rel, content):
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content if isinstance(content, str) else yaml.safe_dump(content), encoding="utf-8")
        return p

    def run_script(self, *args, src=None, out=None, cwd=None):
        env = dict(os.environ, LIMS_IMPORT_SRC_ROOT=(src or self.src).as_posix(), LIMS_IMPORT_OUT_DIR=(out or self.out).as_posix(),
                   PYTHONDONTWRITEBYTECODE="1")
        return subprocess.run([_bash(), SCRIPT.as_posix(), *args], env=env, capture_output=True, text=True, timeout=120,
                              cwd=str(cwd or self.tmp))

    def snap(self, d=None):
        d = d or self.out
        return {str(p.relative_to(d)): p.read_bytes() for p in sorted(d.rglob("*")) if p.is_file()}

    def load(self, module):
        return yaml.safe_load((self.out / ("%s.rules.yml" % module)).read_text(encoding="utf-8"))["groups"]

    def all_rules(self, module):
        return {r["alert"]: r for g in self.load(module) for r in g["rules"]}

    def populate(self):
        self.put(SRC_MAP["lab"][0], LAB_SRC)
        self.put(SRC_MAP["catalog"][0], _rule("CatalogImportQuarantined", 'increase(lims_catalog_imports_total{outcome="quarantined"}[5m]) > 0'))
        self.put(SRC_MAP["billing"][0], _rule("BillingIntegrity", "increase(lims_billing_integrity_violations_total[1d]) > 0"))
        self.put(SRC_MAP["billing"][1], _rule("BillingCounterBusy", "increase(lims_billing_counter_busy_total[5m]) > 5"))
        self.put(SRC_MAP["frontdesk"][0], _rule("FrontdeskTrfBurst", "increase(lims_frontdesk_trf_scans_total[1h]) > 3"))

    # ---- behaviour
    def test_not_a_stub(self):
        self.assertNotIn("not implemented", SCRIPT.read_text(encoding="utf-8"))

    def test_import_adds_only_severity_team_runbook_url(self):  # 02-TRD s11.3 "adding only ..."
        self.populate()
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(sorted(self.snap()), sorted("%s.rules.yml" % m for m in SRC_MAP))
        rules = self.all_rules("lab")
        a, b = rules["LabCriticalUnnotified"], rules["LabNoSeverity"]
        self.assertEqual(_n(a["expr"]), _n("max by (tenant_id) (lims_lab_critical_unnotified_oldest_age_seconds) > 1800"))
        self.assertEqual(a["for"], "1m")
        self.assertEqual(a["labels"]["severity"], "page")
        self.assertEqual(a["labels"]["custom"], "keepme")
        self.assertEqual(a["annotations"]["summary"], "Oldest critical value unnotified for {{ $labels.tenant_id }}")
        self.assertEqual(a["annotations"]["runbook_url"], "infra/runbooks/lab.md#labcriticalunnotified")
        self.assertIn(b["labels"].get("severity"), SEVS)
        self.assertNotIn("for", b, "import must not invent a `for`")
        for x in (a, b):
            self.assertTrue(str(x["labels"].get("team", "")).strip())
            self.assertFalse(set(x["labels"]) - {"severity", "team", "receiver", "custom"}, x["labels"])
            self.assertFalse(set(x) - {"alert", "expr", "for", "labels", "annotations"}, x)
        self.assertEqual(b["annotations"]["runbook_url"], "infra/runbooks/lab.md#labnoseverity")

    def test_multi_file_globs_become_one_file_per_module(self):
        self.populate()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(set(self.all_rules("billing")), {"BillingIntegrity", "BillingCounterBusy"})
        self.assertEqual(set(self.all_rules("frontdesk")), {"FrontdeskTrfBurst"})
        self.assertEqual(self.all_rules("billing")["BillingIntegrity"]["annotations"]["runbook_url"],
                         "infra/runbooks/billing.md#billingintegrity")

    def test_source_is_never_modified_and_run_is_idempotent(self):
        self.populate()
        before = self.snap(self.src)
        self.assertEqual(self.run_script().returncode, 0)
        first = self.snap()
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(self.snap(), first, "second run changed the output")
        self.assertEqual(self.snap(self.src), before, "source file modified")

    def test_missing_sources_are_skipped_and_existing_output_kept(self):
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.snap(), {})
        keep = self.out / "instruments.rules.yml"
        keep.write_text("groups: []\n", encoding="utf-8")
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual(keep.read_text(encoding="utf-8"), "groups: []\n")
        self.assertEqual(self.run_script("--check").returncode, 0)

    def test_repo_default_run_is_clean_regardless_of_cwd(self):  # alert-import-drift as CI runs it
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        env.pop("LIMS_IMPORT_SRC_ROOT", None)
        env.pop("LIMS_IMPORT_OUT_DIR", None)
        r = subprocess.run([_bash(), SCRIPT.as_posix(), "--check"], env=env, capture_output=True, text=True, timeout=120, cwd=str(self.tmp))
        self.assertEqual(r.returncode, 0, "committed imported/ drifts from its sources:\n" + r.stdout + r.stderr)

    # ---- drift detection (AC-17.2 "CI fails when an imported file drifts from its source")
    def test_check_passes_when_in_sync_and_writes_nothing(self):
        self.populate()
        self.run_script()
        before = self.snap()
        r = self.run_script("--check")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.snap(), before)

    def test_check_fails_when_imported_threshold_hand_edited(self):
        self.populate()
        self.run_script()
        p = self.out / "lab.rules.yml"
        p.write_text(p.read_text(encoding="utf-8").replace("1800", "3600"), encoding="utf-8")
        edited = p.read_bytes()
        r = self.run_script("--check")
        self.assertNotEqual(r.returncode, 0, "hand-edited threshold not detected")
        self.assertIn("lab", r.stdout + r.stderr)
        self.assertEqual(p.read_bytes(), edited, "--check must not rewrite the file")

    def test_check_fails_when_source_changes_and_when_imported_file_missing(self):
        self.populate()
        self.run_script()
        lab = self.src / SRC_MAP["lab"][0]
        lab.write_text(LAB_SRC.replace("> 1800", "> 900"), encoding="utf-8")
        self.assertNotEqual(self.run_script("--check").returncode, 0, "source change not detected")
        lab.write_text(LAB_SRC, encoding="utf-8")
        self.assertEqual(self.run_script("--check").returncode, 0)
        (self.out / "catalog.rules.yml").unlink()
        r = self.run_script("--check")
        self.assertNotEqual(r.returncode, 0, "missing imported file not detected")
        self.assertIn("catalog", r.stdout + r.stderr)

    def test_check_fails_when_alert_added_by_hand_to_imported_file(self):
        self.populate()
        self.run_script()
        p = self.out / "catalog.rules.yml"
        d = yaml.safe_load(p.read_text(encoding="utf-8"))
        d["groups"][0]["rules"].append(_rule("Sneaky")["groups"][0]["rules"][0])
        p.write_text(yaml.safe_dump(d), encoding="utf-8")
        self.assertNotEqual(self.run_script("--check").returncode, 0)

    # ---- fail closed (07-SEC: no PHI, nothing silently unroutable, no path tricks)
    def assert_rejected(self, content, why):
        self.put(SRC_MAP["lab"][0], LAB_SRC)
        self.assertEqual(self.run_script().returncode, 0)
        good = self.snap()
        self.put(SRC_MAP["lab"][0], content)
        r = self.run_script()
        self.assertNotEqual(r.returncode, 0, "accepted: %s" % why)
        self.assertEqual(self.snap(), good, "failed import changed existing output (%s)" % why)
        self.assertFalse(list(self.tmp.glob("*.rules.yml")) + list(self.tmp.glob("evil*")), why)

    def test_rejects_bad_alert_name_path_traversal(self):
        self.assert_rejected(_rule("../../evil"), "alert name with path")

    def test_rejects_alert_name_that_breaks_the_anchor(self):
        self.assert_rejected(_rule("Bad Name#x"), "alert name with space/#")

    def test_rejects_missing_expr(self):
        r = _rule("NoExpr")
        del r["groups"][0]["rules"][0]["expr"]
        self.assert_rejected(r, "rule without expr")

    def test_rejects_unroutable_severity(self):  # an alert the router cannot place would vanish silently
        self.assert_rejected(_rule("LabOdd", labels={"severity": "critical"}), "severity critical")

    def test_rejects_phi_label_in_annotation_template(self):
        self.assert_rejected(_rule("LabPhi", annotations={"summary": "patient {{ $labels.patient_id }} waiting"}), "patient_id in summary")

    def test_rejects_phi_label_in_expr(self):
        self.assert_rejected(_rule("LabPhi2", "sum by (barcode) (lims_lab_x_total) > 0"), "barcode in expr")

    def test_rejects_email_address_in_rule(self):
        self.assert_rejected(_rule("LabMail", annotations={"summary": "mail jane.doe" + "@" + "example.org when firing"}), "e-mail in annotation")

    def test_rejects_unknown_argument(self):
        self.assertNotEqual(self.run_script("--bogus").returncode, 0)

    def test_hostile_summary_cannot_inject_yaml_keys(self):  # YAML injection through a free-text annotation
        evil = 'x"\n    labels: {severity: page}\n  - alert: Injected\n    expr: vector(1)\n#'
        self.put(SRC_MAP["lab"][0], _rule("LabEvil", annotations={"summary": evil}))
        r = self.run_script()
        if r.returncode == 0:
            rules = self.all_rules("lab")
            self.assertEqual(set(rules), {"LabEvil"}, "free text became rule structure")
            self.assertEqual(rules["LabEvil"]["annotations"]["summary"], evil)
            self.assertEqual(rules["LabEvil"]["labels"]["severity"], "warn")


if __name__ == "__main__":
    unittest.main()
