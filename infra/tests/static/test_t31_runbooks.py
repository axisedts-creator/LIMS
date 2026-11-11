"""T-31 tests (tester role): runbook-link lint, on-call, incident response + tabletop record, status page.

Covers 06-PLAN row T-31 (done_when: every alert anchor exists; tabletop held and recorded; tests: runbook-link lint),
AC-23.1, IS-28, 02-TRD s11.3 (annotations.runbook_url -> infra/runbooks/<family>.md#<alert>), 04-UI-UX s4 (catalogue,
entry template), s5 (SEV matrix, on-call, privacy form, templates), 03-APP-FLOW s12 (IR states) and s15 (status page),
07-SECURITY REQ-SEC-134 (IR runbook, tabletop twice a year) and REQ-SEC-142 (static status page, no PHI).
LD-45 (lean/full topology) does not change any text here; runbooks must not hard-code host counts.

CONTRACTS where the spec is silent (the writer must meet them; a disagreement is a dispute, not a silent change):
 * Lint (what "every alert anchor exists" means): for EVERY alert in infra/monitoring/rules/*.rules.yml and
   rules/imported/*.rules.yml, annotations.runbook_url is `infra/runbooks/<stem>.md#<alertname lower-case>`, the file
   exists, and it holds a level-2 heading `## <AlertName>` whose GitHub slug equals the anchor, followed by the s4.2
   template lines (Severity:, Owner:, Last tested:, **Means:**, **Impact:**, **Check first:**, **Fix:**,
   **Escalate when:**, **Close-out:**) with Severity equal to a severity the rule file uses for that alert name.
   The file stem is whatever the rules already point to (host.md, ops.md, security.md ... exist then); no rule edits.
   Also every `<file>.md#<anchor>` reference inside infra/runbooks/**/*.md and every relative markdown link resolves.
 * Files owned here: README.md, oncall.md, incident-response.md, ddos.md, monitoring.md, ird-access.md, plus
   tabletop-log/<YYYY-MM-DD>-<slug>.md (precedent: drill-log/). patching.md, dr.md, secrets.md, deploy.md, studio.md
   belong to T-28/T-29/T-26 and are checked only through the lint above.
 * host runbook: the file the host rules point to also holds a `luks` heading (R11: unlock at boot, console fallback).
 * Tabletop record (AC-23.1): `Key: value` lines, keys listed in TABLETOP_KEYS; scenario is synthetic (no PHI), all IR
   states detected..notified appear in order, `Evidence frozen within 4 h: yes|no`, privacy sections s.12(4), s.26(1),
   s.29, s.30, s.31 named, counsel line, UNVERIFIED/B16 noted, `Next tabletop:` within 183 days of `Date:`.
   incident-response.md has `## Tabletop log` linking every record and stating the twice-a-year cadence.
 * Status page: infra/status/status.yaml = {updated: ISO-8601 UTC, components: [{id, name, state}], notices: [{title,
   starts, ends?, text}]}; ids include staff_web, portal, api (02-TRD origins); state in the five 04 s5.4 values.
   Role infra/ansible/roles/status_page/{defaults/main.yml,tasks/main.yml,templates/index.html.j2}: tasks load the yaml
   into `status`, assert the states, and ansible.builtin.template the page (0644) to `status_page_root`; the template
   escapes every value (`| e`; Ansible does not autoescape), is self-contained (no external URL/script), shows
   "All systems operational" only when every component is operational and there are no notices, and carries a
   "status unknown" banner driven by the 15-minute (900 s) staleness rule. nginx wiring (`^~ /status/`) is T-13's.
Stdlib + jinja2 + PyYAML. Missing file = FAIL. Run from repo root:
  python -B -m unittest discover -s infra/tests/static -p "test_t31_*.py" -v
"""
import datetime
import re
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
RB = ROOT / "infra" / "runbooks"
RULES = ROOT / "infra" / "monitoring" / "rules"
STATUS_YAML = ROOT / "infra" / "status" / "status.yaml"
ROLE = ROOT / "infra" / "ansible" / "roles" / "status_page"
TABLETOPS = RB / "tabletop-log"

STATES = ["operational", "degraded", "partial_outage", "major_outage", "maintenance"]
IR_STATES = ["detected", "triaged", "contained", "evidence_preserved", "assessed", "notified", "recovered", "reviewed"]
ENTRY_KEYS = ["Severity:", "Owner:", "Last tested:", "**Means:**", "**Impact:**", "**Check first:**", "**Fix:**",
              "**Escalate when:**", "**Close-out:**"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
PHONE_RE = re.compile(r"\d{7,}")
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
REF_RE = re.compile(r"(?<![A-Za-z0-9_/-])([a-z][a-z0-9_-]*\.md)#([A-Za-z0-9_-]+)")
LINK_RE = re.compile(r"\[[^\]]*\]\(([^)\s]+)\)")
TABLETOP_KEYS = ["Date", "Scenario", "Participants", "Incident commander", "Severity", "Evidence frozen within 4 h",
                 "Notification decision", "Counsel", "Actions", "Next tabletop"]


def slug(heading):
    s = heading.strip().lower().replace("`", "")
    s = re.sub(r"[^a-z0-9 _-]", "", s)
    return s.replace(" ", "-")


def read(p):
    assert p.exists(), "missing %s" % p.relative_to(ROOT)
    return p.read_text(encoding="utf-8")


def headings(text):
    return [(len(m.group(1)), m.group(2).strip()) for m in re.finditer(r"^(#{1,6})\s+(.+?)\s*$", text, re.M)]


def anchors(path):
    return {slug(t) for _, t in headings(read(path))}


def sections(text):
    """level-2 sections: {heading text: body}"""
    out, cur, buf = {}, None, []
    for line in text.splitlines():
        m = re.match(r"##\s+(.+?)\s*$", line)
        if m and not line.startswith("###"):
            if cur is not None:
                out[cur] = "\n".join(buf)
            cur, buf = m.group(1), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        out[cur] = "\n".join(buf)
    return out


def alerts():
    """{name: {"sev": set, "url": set, "files": set}} over every rule file (own + imported)."""
    out = {}
    for f in sorted(RULES.glob("*.rules.yml")) + sorted((RULES / "imported").glob("*.rules.yml")):
        for g in (yaml.safe_load(f.read_text(encoding="utf-8")) or {}).get("groups", []):
            for r in g.get("rules", []):
                if "alert" not in r:
                    continue
                a = out.setdefault(r["alert"], {"sev": set(), "url": set(), "files": set()})
                lab = (r.get("labels") or {}).get("severity")
                if isinstance(lab, str) and "{{" in lab:  # templated label (T-19, LD-45 lean routing): take its literals
                    a["sev"].update(re.findall(r"page|warn|info", lab))
                else:
                    a["sev"].add(lab)
                a["url"].add((r.get("annotations") or {}).get("runbook_url"))
                a["files"].add(f.name)
    return out


class RunbookLinkLint(unittest.TestCase):  # done_when 1, tests "runbook-link lint", 02-TRD s11.3
    def test_rules_exist_to_lint(self):
        self.assertGreaterEqual(len(alerts()), 60, "rule files missing or empty")

    def test_every_alert_anchor_exists_with_the_entry_template(self):
        bad = []
        for name, a in sorted(alerts().items()):
            urls = a["url"]
            if len(urls) != 1:
                bad.append("%s: runbook_url differs across its rules: %s" % (name, sorted(map(str, urls))))
                continue
            m = re.fullmatch(r"infra/runbooks/([a-z0-9_-]+)\.md#([a-z0-9_-]+)", str(next(iter(urls))))
            if not m or m.group(2) != name.lower():
                bad.append("%s: runbook_url %r is not infra/runbooks/<stem>.md#%s" % (name, next(iter(urls)), name.lower()))
                continue
            path = RB / (m.group(1) + ".md")
            if not path.exists():
                bad.append("%s: %s does not exist" % (name, path.name))
                continue
            sec = {h: b for h, b in sections(path.read_text(encoding="utf-8")).items() if slug(h) == m.group(2)}
            if len(sec) != 1:
                bad.append("%s: %s needs exactly one `## %s` heading (found %d)" % (name, path.name, name, len(sec)))
                continue
            body = next(iter(sec.values()))
            miss = [k for k in ENTRY_KEYS if k not in body]
            if miss:
                bad.append("%s: %s section lacks %s" % (name, path.name, miss))
            sev = re.search(r"Severity:\s*(page|warn|info)", body)
            # ruling: rules with no page|warn|info label (Watchdog, routed by its dead-man rule) skip the membership check
            if not sev or (a["sev"] & {"page", "warn", "info"} and sev.group(1) not in a["sev"]):
                bad.append("%s: runbook Severity %r not in rule severities %s" % (name, sev and sev.group(1), sorted(a["sev"])))
            lt = re.search(r"Last tested:\s*(\d{4}-\d{2}-\d{2}|never)", body)
            if not lt:
                bad.append("%s: Last tested must be YYYY-MM-DD or never" % name)
        self.assertEqual(bad, [], "\n".join(bad[:40]) + ("\n... %d total" % len(bad) if len(bad) > 40 else ""))

    def test_no_orphan_alert_sections_in_own_runbooks(self):
        # a `## <PascalCase>` template entry in a family runbook must be a real alert (renamed alerts leave dead anchors)
        names = set(alerts())
        orphans = []
        for stem in ("edge", "db", "backup", "audit", "runtime", "host", "security", "ops", "drill"):
            p = RB / (stem + ".md")
            if not p.exists():
                continue
            for h, body in sections(p.read_text(encoding="utf-8")).items():
                if "Severity:" in body and re.fullmatch(r"[A-Z][A-Za-z0-9]+", h) and h not in names:
                    orphans.append("%s#%s" % (stem, h))
        self.assertEqual(orphans, [])

    def test_cross_references_inside_runbooks_resolve(self):
        files = sorted(RB.rglob("*.md"))
        self.assertGreater(len(files), 10)
        bad = []
        cache = {}
        for f in files:
            text = f.read_text(encoding="utf-8")
            for fn, an in REF_RE.findall(text):
                tgt = f.parent / fn if (f.parent / fn).exists() else RB / fn
                if not tgt.exists():
                    bad.append("%s -> %s#%s (no such file)" % (f.name, fn, an))
                    continue
                if tgt not in cache:
                    cache[tgt] = anchors(tgt)
                if an.lower() not in cache[tgt] and an not in cache[tgt]:
                    bad.append("%s -> %s#%s (no such heading)" % (f.name, fn, an))
            for link in LINK_RE.findall(text):
                if re.match(r"[a-z]+:", link) or link.startswith("#"):
                    continue
                target, _, an = link.partition("#")
                tgt = (f.parent / target).resolve()
                if not tgt.exists():
                    bad.append("%s -> link %s (no such file)" % (f.name, link))
                elif an and tgt.suffix == ".md" and an not in anchors(tgt):
                    bad.append("%s -> link %s (no such heading)" % (f.name, link))
        self.assertEqual(bad, [], "\n".join(bad[:40]))


class Catalogue(unittest.TestCase):  # 04-UI-UX s4.1
    def test_readme_index_links_every_runbook_file_it_covers(self):
        t = read(RB / "README.md")
        self.assertRegex(t, r"(?i)what do i do when")
        self.assertRegex(t, r"(?i)SEV1")
        self.assertRegex(t, r"(?i)contacts")
        for stem in ("oncall", "incident-response", "ddos", "edge", "db", "backup", "audit", "runtime", "monitoring"):
            self.assertRegex(t, r"\(%s\.md(#[^)]*)?\)" % stem, "README must link %s.md" % stem)
        # every runbook family file that exists is reachable from the index
        for p in RB.glob("*.md"):
            if p.name != "README.md":
                self.assertIn(p.name, t, "README does not mention %s" % p.name)

    def test_host_runbook_covers_luks_unlock(self):  # PLAN R11
        host = next((RB / n for n in ("host.md", "hosts.md") if (RB / n).exists()), None)
        self.assertIsNotNone(host, "host.md (rules point there) missing")
        self.assertTrue(any("luks" in h.lower() for _, h in headings(read(host))), "no LUKS unlock heading")
        t = read(host).lower()
        self.assertIn("console", t)

    def test_edge_limsauthjailban_matches_addendum_a3_2(self):  # 04 s4.2a
        sec = sections(read(RB / "edge.md"))
        body = next((b for h, b in sec.items() if slug(h) == "limsauthjailban"), None)
        self.assertIsNotNone(body, "edge.md#limsauthjailban missing")
        for needle in ("Severity: page", "Owner: C1", "300", "lims-auth", "unbanip", "ddos.md", "ops_audit", "NAT",
                       "401"):
            self.assertIn(needle, body, needle)
        self.assertIn("manual-ban", anchors(RB / "edge.md"))
        t = read(RB / "edge.md")
        self.assertRegex(t, r"(?is)EdgeNotFoundSpike.*never ban.*NAT", "D-211: never ban a lab NAT for 404s")

    def test_ddos_runbook_five_steps(self):  # 04 s4.3
        t = read(RB / "ddos.md")
        for needle in ("RateLimitSpike", "Edge5xxRate", "volumetric", "application", "edge.md#manual-ban",
                       "isp_mitigation_contact", "B12", "B11", "founder", "status page", "incident"):
            self.assertRegex(t, "(?i)" + re.escape(needle), needle)
        self.assertRegex(t, r"(?i)no foreign cdn", "must forbid foreign CDN without founder approval")
        self.assertRegex(t, r"(?i)unverified", "ISP scrubbing availability is UNVERIFIED (04 I7)")

    def test_monitoring_runbook_anchors(self):  # 03 s15 error states link here
        a = anchors(RB / "monitoring.md")
        for want in ("prometheus-down", "alertmanager-down", "victorialogs-down", "watchdog", "metriccardinalityhigh"):
            self.assertIn(want, a, want)
        self.assertIn("amtool", read(RB / "monitoring.md"))

    def test_ird_access_is_a_blocked_placeholder(self):
        t = read(RB / "ird-access.md")
        self.assertRegex(t, r"B6")
        self.assertRegex(t, r"(?i)blocked")
        self.assertLess(len(t), 2500, "placeholder only; do not invent IRD steps")


class OnCall(unittest.TestCase):  # AC / IS-28, 04 s5.2
    def setUp(self):
        self.t = read(RB / "oncall.md")

    def test_rota_ack_escalate_handover(self):
        for pat in (r"(?i)weekly", r"(?i)primary", r"(?i)secondary", r"ack <name>", r"15 min", r"30 min",
                    r"(?i)founder", r"Monday 10:00 NPT", r"ops-note\.sh", r"(?i)silence", r"repeat_interval"):
            self.assertRegex(self.t, pat)
        self.assertRegex(self.t, r"(?i)handover")

    def test_paging_channel_is_email_sms_needs_approval(self):
        self.assertRegex(self.t, r"(?i)e-?mail")
        self.assertRegex(self.t, r"CR-C1-006")
        self.assertRegex(self.t, r"(?i)sms[^.\n]*(approval|approved)")

    def test_links_to_incident_response_and_has_the_sev_matrix(self):
        self.assertIn("incident-response.md", self.t)
        ir = read(RB / "incident-response.md")
        for sev in ("SEV1", "SEV2", "SEV3", "SEV4"):
            self.assertIn(sev, ir)

    def test_no_contact_data_committed(self):  # contacts live in secrets (alert_contacts), never in git
        for f in ("oncall.md", "README.md"):
            t = read(RB / f)
            self.assertIsNone(EMAIL_RE.search(t), "%s contains an e-mail address" % f)
            self.assertIsNone(PHONE_RE.search(t), "%s contains a 7+ digit run (phone?)" % f)


class IncidentResponse(unittest.TestCase):  # AC-23.1, 03 s12, 04 s5.3-5.4, REQ-SEC-134
    def setUp(self):
        self.t = read(RB / "incident-response.md")

    def test_all_states_in_order_with_deadlines(self):
        pos = [self.t.find("`%s`" % s) for s in IR_STATES]
        self.assertTrue(all(p >= 0 for p in pos), dict(zip(IR_STATES, pos)))
        self.assertEqual(pos, sorted(pos), "states must appear in lifecycle order")
        self.assertRegex(self.t, r"(?i)4 ?h")                       # evidence within 4 h of triaged
        self.assertRegex(self.t, r"72 ?h")                          # own target after assessed
        self.assertRegex(self.t, r"(?i)10 working days")            # post-incident review

    def test_evidence_freeze_procedure(self):
        for needle in ("pg_dump", "sha256", "VictoriaLogs", "ops_audit", "nginx", "audit_reader"):
            self.assertIn(needle, self.t, needle)
        self.assertRegex(self.t, r"(?i)founder[^.\n]*approv")      # audit_reader only with founder approval
        self.assertRegex(self.t, r"(?i)snapshot")

    def test_privacy_act_sections_and_unverified_flags(self):
        for sec in (r"s\.12\(4\)", r"s\.26\(1\)", r"s\.29", r"s\.30", r"s\.31", r"s\.25", r"s\.27\(1\)"):
            self.assertRegex(self.t, sec)
        self.assertRegex(self.t, r"(?i)three months")
        self.assertRegex(self.t, r"B16")
        self.assertRegex(self.t, r"UNVERIFIED")
        self.assertRegex(self.t, r"2077")
        # must not assert a statutory breach-notification deadline (04 L17 lists none)
        self.assertNotRegex(self.t, r"(?i)(statutory|legal(ly)?|act requires)[^.\n]{0,40}(deadline|within \d+ ?(h|hours|days))")

    def test_privacy_assessment_form_fields(self):  # 04 s5.3
        for field in ("incident id", "tenants affected", "data classes", "record counts", "actor type",
                      "disclosure confirmed", "containment time", "evidence hashes", "public body",
                      "counsel consulted", "decision on tenant notification"):
            self.assertRegex(self.t, "(?i)" + field, field)

    def test_notification_templates_have_no_phi(self):  # 04 s5.4, REQ-SEC-134
        sec = sections(self.t)
        tpl = next((b for h, b in sec.items() if "notification" in h.lower()), "")
        self.assertTrue(tpl, "no notification templates section")
        for needle in ("Security notice", "Planned maintenance", "<lab name>", "<ops contact>"):
            self.assertIn(needle, tpl, needle)
        self.assertRegex(tpl, r"(?i)we do not send patient data by e-?mail")
        self.assertIsNone(EMAIL_RE.search(tpl))
        self.assertIsNone(PHONE_RE.search(tpl))
        self.assertIsNone(UUID_RE.search(tpl))
        for s in STATES:
            self.assertIn(s, tpl, "status page state %s listed with the templates" % s)
        self.assertRegex(tpl, r"(?i)patient notification is the tenant")

    def test_commands_exist_in_repo(self):
        for rel in re.findall(r"infra/ci/[a-z-]+\.sh", self.t):
            self.assertTrue((ROOT / rel).exists(), rel)

    def test_roles_and_containment_actions(self):
        for needle in ("incident commander", "C2", "revoke", "isolate", "tenant"):
            self.assertRegex(self.t, "(?i)" + needle)


class TabletopRecord(unittest.TestCase):  # done_when 2, AC-23.1 "tabletop twice a year, recorded"
    def records(self):
        # LD-106(1): AC-22.2 DR site-failover walk-through is not a REQ-SEC-134 security-incident record.
        recs = sorted(p for p in TABLETOPS.glob("*.md") if not p.name.endswith("-site-failover.md")) if TABLETOPS.exists() else []
        self.assertTrue(recs, "no record under infra/runbooks/tabletop-log/")
        return recs

    @staticmethod
    def kv(text):
        d = {}
        for line in text.splitlines():
            m = re.match(r"\s*[-*]?\s*\**([A-Za-z][A-Za-z0-9 ()/.-]*?)\**:\**\s+(.+)$", line)
            if m:
                d.setdefault(m.group(1).strip(), m.group(2).strip())
        return d

    def test_record_exists_and_is_dated(self):
        for r in self.records():
            self.assertRegex(r.name, r"^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$")

    def test_record_fields(self):
        for r in self.records():
            t, d = r.read_text(encoding="utf-8"), self.kv(r.read_text(encoding="utf-8"))
            for k in TABLETOP_KEYS:
                self.assertIn(k, d, "%s lacks `%s:`" % (r.name, k))
            self.assertTrue(r.name.startswith(d["Date"]), "file date != Date:")
            self.assertRegex(d["Scenario"], r"(?i)synthetic", "tabletop must use a synthetic scenario (no PHI)")
            self.assertRegex(d["Severity"], r"SEV[1-4]")
            self.assertRegex(d["Evidence frozen within 4 h"], r"(?i)^(yes|no)\b")
            for sec in (r"s\.12\(4\)", r"s\.26\(1\)", r"s\.29", r"s\.30", r"s\.31"):
                self.assertRegex(t, sec, "%s: privacy section %s not recorded" % (r.name, sec))
            self.assertRegex(t, r"(?i)sha256")
            self.assertRegex(t, r"B16")
            self.assertRegex(t, r"UNVERIFIED")
            pos = [t.find(s) for s in IR_STATES[:6]]
            self.assertTrue(all(p >= 0 for p in pos), "%s: states detected..notified missing %s" % (r.name, pos))
            self.assertEqual(pos, sorted(pos), "%s: states out of order" % r.name)
            self.assertRegex(d["Actions"], r"\S")
            self.assertIsNone(EMAIL_RE.search(t))
            self.assertIsNone(UUID_RE.search(t), "records hold counts/timings only, no tenant ids")

    def test_next_tabletop_within_six_months(self):
        for r in self.records():
            d = self.kv(r.read_text(encoding="utf-8"))
            held = datetime.date.fromisoformat(d["Date"])
            nxt = datetime.date.fromisoformat(re.match(r"\d{4}-\d{2}-\d{2}", d["Next tabletop"]).group(0))
            self.assertGreater(nxt, held)
            self.assertLessEqual((nxt - held).days, 183, "twice a year = at most 6 months apart (REQ-SEC-134)")
            self.assertLessEqual(held, datetime.date(2026, 11, 8) + datetime.timedelta(days=1),
                                 "record dated in the future cannot be a held tabletop")

    def test_incident_response_links_the_log_and_cadence(self):
        t = read(RB / "incident-response.md")
        body = next((b for h, b in sections(t).items() if slug(h) == "tabletop-log"), None)
        self.assertIsNotNone(body, "incident-response.md needs `## Tabletop log`")
        self.assertRegex(body, r"(?i)(twice a year|every six months|semi-?annual)")
        for r in self.records():
            self.assertIn("tabletop-log/" + r.name, body, "log must link %s" % r.name)


class StatusYaml(unittest.TestCase):  # REQ-SEC-142, 03 s15
    def setUp(self):
        self.d = yaml.safe_load(read(STATUS_YAML))

    def test_shape(self):
        self.assertEqual(set(self.d), {"updated", "components", "notices"})
        self.assertIsInstance(self.d["updated"], str, "quote the timestamp so YAML keeps it a string")
        self.assertRegex(str(self.d["updated"]), r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(Z|\+00:00)?$")
        ids = [c["id"] for c in self.d["components"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertTrue({"staff_web", "portal", "api"} <= set(ids), ids)
        for c in self.d["components"]:
            self.assertEqual(set(c), {"id", "name", "state"})
            self.assertIn(c["state"], STATES)
            self.assertRegex(c["id"], r"^[a-z][a-z0-9_]*$")
        self.assertIsInstance(self.d["notices"], list)
        for n in self.d["notices"]:
            self.assertTrue({"title", "starts", "text"} <= set(n) <= {"title", "starts", "ends", "text"})

    def test_committed_default_is_all_operational(self):
        self.assertTrue(all(c["state"] == "operational" for c in self.d["components"]))
        self.assertEqual(self.d["notices"], [])

    def test_no_phi_tenant_names_or_contacts(self):  # REQ-SEC-142
        raw = read(STATUS_YAML)
        self.assertIsNone(EMAIL_RE.search(raw))
        self.assertIsNone(PHONE_RE.search(raw.replace(str(self.d["updated"]), "")))
        self.assertIsNone(UUID_RE.search(raw))
        self.assertNotRegex(raw, r"(?i)tenant|patient|lab name|password|token")


class StatusPageRole(unittest.TestCase):
    def _tpl(self):
        return read(ROLE / "templates" / "index.html.j2")

    def render(self, status):
        env = jinja2.Environment(keep_trailing_newline=True, autoescape=False,  # Ansible default: NO autoescape
                                 undefined=jinja2.StrictUndefined)
        return env.from_string(self._tpl()).render(status=status, status_page_now=status.get("updated"))

    def base(self, **over):
        d = yaml.safe_load(read(STATUS_YAML))
        d.update(over)
        return d

    def test_role_files_and_tasks(self):
        for rel in ("defaults/main.yml", "tasks/main.yml", "templates/index.html.j2"):
            self.assertTrue((ROLE / rel).exists(), rel)
        t = read(ROLE / "tasks" / "main.yml")
        tasks = yaml.safe_load(t)
        self.assertIsInstance(tasks, list)
        self.assertIn("status_page_root", read(ROLE / "defaults" / "main.yml"))
        self.assertIn("ansible.builtin.template", t)
        self.assertIn("ansible.builtin.assert", t)
        for s in STATES:
            self.assertIn(s, t, "tasks must assert the state vocabulary: %s" % s)
        self.assertRegex(t, r"from_yaml")
        self.assertRegex(t, r"mode:\s*['\"]?0644")
        self.assertNotRegex(t, r"(?i)password|secret|token|vault")

    def test_all_operational_message(self):
        h = self.render(self.base())
        self.assertIn("All systems operational", h)
        for c in self.base()["components"]:
            self.assertIn(c["name"], h)

    def test_degraded_component_replaces_the_all_clear(self):
        d = self.base()
        d["components"][0]["state"] = "partial_outage"
        h = self.render(d)
        self.assertNotIn("All systems operational", h)
        self.assertRegex(h, r"(?i)partial outage")        # colour is never the only signal (04 s9)

    def test_every_state_is_rendered_as_text(self):
        for s in STATES:
            d = self.base()
            d["components"][0]["state"] = s
            self.assertRegex(self.render(d), "(?i)" + s.replace("_", " "), s)

    def test_notice_blocks_all_clear_and_is_shown(self):
        d = self.base(notices=[{"title": "Planned maintenance", "starts": "2026-12-01T16:15:00Z",
                                "text": "Services affected: web"}])
        h = self.render(d)
        self.assertIn("Planned maintenance", h)
        self.assertIn("Services affected: web", h)
        self.assertNotIn("All systems operational", h)

    def test_values_are_escaped(self):  # injection through status.yaml
        evil = "<script>alert(1)</script>"
        d = self.base(notices=[{"title": evil, "starts": "2026-12-01T16:15:00Z", "text": "<img src=x onerror=a()>"}])
        d["components"][0]["name"] = evil
        h = self.render(d)
        self.assertNotIn("<script>alert(1)", h)
        self.assertNotIn("<img src=x", h)
        self.assertIn("&lt;script&gt;", h)

    def test_self_contained_static_page(self):
        h = self.render(self.base())
        self.assertNotRegex(h, r"(?i)(src|href|action)\s*=\s*[\"']?(https?:)?//")
        self.assertNotRegex(h, r"(?i)<script[^>]*\ssrc=")
        self.assertNotRegex(h, r"(?i)@import|url\(\s*[\"']?https?:")
        self.assertRegex(h, r'(?i)<html[^>]*\slang="en"')
        self.assertRegex(h, r"(?i)<meta[^>]+charset")
        self.assertNotRegex(h, r"(?i)tenant|patient")

    def test_stale_banner_rule(self):  # 03 s15: stale > 15 min shows "status unknown"
        h = self.render(self.base())
        self.assertRegex(h, r"(?i)status unknown")
        self.assertRegex(h, r"\b900\b|15\s*\*\s*60")
        self.assertIn(str(self.base()["updated"]), h, "updated timestamp must be in the page for the staleness check")
        self.assertRegex(h, r"(?i)<noscript")             # JS off: banner text still reachable / explained


if __name__ == "__main__":
    unittest.main()
