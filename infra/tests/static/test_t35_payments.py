"""T-35 tests (tester role): C15 payment infrastructure, CR-C15-008 items 4 and 5 (02-TRD s7.12; 06-PLAN row T-35).

Items 1-3 (payment locations, headers, zone, :token log masking) and item 6 (alerts, finance-oncall-email) are already proven by
test_t13_edge.py (PaymentsLocationsTest, access-log tests; AC-04.8 / AC-18.4) and test_t18/t21 (rules + receivers); live AC-04.8 is
infra/tests/external/ratelimit.py. This module covers what T-35 adds: per-environment gateway egress, the egress probe, the KEK.
done_when: "staging worker reaches UAT gateway hosts and nothing else; production enablement waits for C15 PG-T23".

CONTRACTS where the spec is silent (writer meets them or files a dispute; nothing here is a silent design change):
 * infra/edge/egress-allowlist.yaml keeps its `destinations:` entries with EXACTLY the 7 keys of T-14 (no new per-entry key). The
   per-environment scope is a new TOP-LEVEL key `env_scope: {staging: [fqdn...], prod: [fqdn...]}` listing the owner-C15 gateway
   FQDNs of each environment (dev: absent or empty - dev uses simulators). An owner-C15 entry reaches Squid only when its fqdn is in
   env_scope[env] AND it is approved + via squid + port 443 (fail closed: an owner-C15 entry in no scope is never loaded). Entries
   of other owners are not scoped. `env` is the inventory variable (dev|staging|prod; prod-lean/staging-lean set the same values).
 * f01_status: the two UAT entries are `approved` (done_when: staging worker reaches them); the two prod entries stay `pending`
   until C15 PG-T23 (production enablement), so a prod Squid loads no gateway name today.
 * roles/egress_proxy/tasks/main.yml: the test evaluates the role's set_fact tasks in order with jinja2 (ansible `lookup('ansible.
   builtin.file', p)` and `from_yaml` provided; role defaults rendered; `egress_proxy_allowlist` and `env` overridden) and reads
   the resulting `egress_proxy_fqdns` (list). No other contract on variable names.
 * infra/tests/internal/egress_probe.sh gets mode `payments <container>`: env PAYMENTS_ALLOWED_FQDNS and PAYMENTS_DENIED_FQDNS
   (comma lists, both non-empty else exit 2). Like `proxy`: EVERY allowed fqdn must answer through Squid (status not 000/403/407/
   5xx); EVERY denied fqdn must get exactly 403 on CONNECT; direct egress (1.1.1.1:443, 8.8.8.8:53, 169.254.169.254:80) must be
   closed; stopped container / missing curl or nc = failure. Exit 0 ok, 1 mismatch, 2 usage. Live use: staging worker with
   allowed = UAT hosts, denied = the prod hosts + any other gateway.
 * runbook infra/runbooks/secrets.md section `## Payments KEK` (anchor #payments-kek): states keys are distinct per environment and
   that the KEK never enters the database (D-118), besides the existing add -> active -> rewrap -> remove order.
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run: python -B -m unittest discover -s infra/tests/static -p "test_t35_*.py" -v
"""
import ast
import copy
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_t14_probes import DATA_WG, Fake, bash, need_script  # noqa: E402  (fake docker harness of T-14)

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
ALLOW = INFRA / "edge" / "egress-allowlist.yaml"
ROLE = INFRA / "ansible" / "roles" / "egress_proxy"
RUNBOOK = INFRA / "runbooks" / "secrets.md"
SCHEMAS = INFRA / "secrets" / "schema"

UAT = ["uat.esewa.com.np", "dev.khalti.com"]
PROD = ["epay.esewa.com.np", "khalti.com"]


def need(p):
    if not Path(p).is_file():
        raise AssertionError("missing %s" % Path(p).relative_to(ROOT).as_posix())
    return Path(p).read_text(encoding="utf-8")


def doc():
    d = yaml.safe_load(need(ALLOW))
    if not isinstance(d, dict) or not isinstance(d.get("destinations"), list):
        raise AssertionError("egress-allowlist.yaml: `destinations:` list required")
    return d


def by_fqdn(d):
    return {x["fqdn"]: x for x in d["destinations"]}


# ============================================================================ allowlist content (CR-C15-008 item 4)
class PaymentsAllowlist(unittest.TestCase):
    def test_four_gateway_entries(self):
        e = by_fqdn(doc())
        for f in UAT + PROD:
            self.assertIn(f, e, f)
            self.assertEqual((e[f]["port"], e[f]["via"], e[f]["owner"]), (443, "squid", "C15"), f)

    def test_no_other_gateway_egress(self):  # "no other gateway egress"
        d = doc()
        c15 = sorted(x["fqdn"] for x in d["destinations"] if x["owner"] == "C15")
        self.assertEqual(c15, sorted(UAT + PROD), "only the four CR-C15-008 gateway FQDNs may be owned by C15")
        self.assertFalse([x for x in d["destinations"] if "fonepay" in str(x["fqdn"]).lower()], "Fonepay is blocked (B8): no egress entry")

    def test_entries_keep_the_t14_schema(self):  # the scope must not add a per-entry key (T-14 asserts the exact 7)
        keys = {"fqdn", "port", "via", "owner", "purpose", "section_04_11", "f01_status"}
        for x in doc()["destinations"]:
            self.assertEqual(set(x), keys, x)

    def test_env_scope(self):
        s = doc().get("env_scope")
        self.assertIsInstance(s, dict, "top-level `env_scope:` mapping required")
        self.assertEqual(sorted(s.get("staging") or []), sorted(UAT), "staging = UAT hosts only")
        self.assertEqual(sorted(s.get("prod") or []), sorted(PROD), "prod = production hosts only")
        self.assertEqual(s.get("dev") or [], [], "dev has no gateway egress")
        self.assertLessEqual(set(s), {"dev", "staging", "prod"})

    def test_uat_approved_prod_waits_for_pg_t23(self):  # done_when
        e = by_fqdn(doc())
        for f in UAT:
            self.assertEqual(e[f]["f01_status"], "approved", "%s: staging worker must reach it" % f)
        for f in PROD:
            self.assertEqual(e[f]["f01_status"], "pending", "%s: production enablement waits for C15 PG-T23" % f)


# ============================================================================ role: what Squid is loaded with, per env
def _tpl_env(allow_text):
    e = jinja2.Environment(undefined=jinja2.StrictUndefined)
    e.globals["lookup"] = lambda plugin, path: Path(path).read_text(encoding="utf-8")
    e.filters["from_yaml"] = yaml.safe_load
    return e


def _render(e, v, ctx):
    if isinstance(v, str) and "{{" in v:
        out = e.from_string(v).render(**ctx).strip()
        try:
            return ast.literal_eval(out)
        except (ValueError, SyntaxError):
            return out
    return v


def role_fqdns(allow_doc, env):
    """Run the role's set_fact tasks (jinja2 stand-in for ansible) against a temp copy of the allowlist; return egress_proxy_fqdns."""
    tasks = yaml.safe_load(need(ROLE / "tasks" / "main.yml"))
    defaults = yaml.safe_load(need(ROLE / "defaults" / "main.yml")) or {}
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "egress-allowlist.yaml"
        p.write_text(yaml.safe_dump(allow_doc, sort_keys=False), encoding="utf-8")
        e = _tpl_env(None)
        ctx = {"env": env, "playbook_dir": td}
        for k, v in defaults.items():
            try:
                ctx[k] = _render(e, v, ctx)
            except Exception:
                pass
        ctx["egress_proxy_allowlist"] = p.as_posix()
        for t in tasks:
            sf = t.get("ansible.builtin.set_fact") or t.get("set_fact")
            if not sf:
                continue
            for k, v in sf.items():
                ctx[k] = _render(e, v, ctx)
        if "egress_proxy_fqdns" not in ctx:
            raise AssertionError("role does not set egress_proxy_fqdns")
        return ctx["egress_proxy_fqdns"]


def with_prod_approved(d):
    d = copy.deepcopy(d)
    for x in d["destinations"]:
        if x["fqdn"] in PROD:
            x["f01_status"] = "approved"
    return d


class SquidScopePerEnv(unittest.TestCase):
    def names(self, env, d=None):
        return set(role_fqdns(d or doc(), env))

    def test_staging_reaches_uat_and_nothing_else_of_c15(self):  # done_when
        n = self.names("staging")
        self.assertTrue(set(UAT) <= n, n)
        self.assertFalse(n & set(PROD), "prod gateways must not be reachable from staging: %s" % n)

    def test_prod_loads_no_gateway_until_enabled(self):  # production enablement waits for PG-T23
        n = self.names("prod")
        self.assertFalse(n & set(UAT + PROD), n)

    def test_dev_has_no_gateway(self):
        self.assertFalse(self.names("dev") & set(UAT + PROD))

    def test_prod_once_enabled_has_prod_hosts_only(self):  # the PG-T23 flip = status approved, nothing else to edit
        d = with_prod_approved(doc())
        self.assertEqual(self.names("prod", d) & set(UAT + PROD), set(PROD))
        self.assertEqual(self.names("staging", d) & set(UAT + PROD), set(UAT), "enabling prod must not widen staging")

    def test_unscoped_gateway_fails_closed(self):  # a C15 entry that is in no env_scope list is loaded nowhere
        d = doc()
        d["destinations"].append({"fqdn": "pay.new-gateway.example.com.np", "port": 443, "via": "squid", "owner": "C15",
                                  "purpose": "synthetic", "section_04_11": "synthetic", "f01_status": "approved"})
        for env in ("dev", "staging", "prod"):
            self.assertNotIn("pay.new-gateway.example.com.np", self.names(env, d), env)

    def test_other_owners_are_not_scoped(self):  # clamav mirror keeps working in every env once approved
        d = doc()
        for x in d["destinations"]:
            if x["fqdn"] == "database.clamav.net":
                x["f01_status"] = "approved"
        for env in ("dev", "staging", "prod"):
            self.assertIn("database.clamav.net", self.names(env, d), env)

    def test_squid_conf_for_staging_names_only_uat(self):
        j = jinja2.Environment(undefined=jinja2.StrictUndefined)
        t = j.from_string(need(ROLE / "templates" / "squid.conf.j2"))
        conf = t.render(egress_proxy_fqdns=role_fqdns(doc(), "staging"), egress_proxy_src_cidr="172.30.20.0/24")
        acl = [l for l in conf.splitlines() if l.startswith("acl lims_allowed_dst")]
        self.assertEqual(len(acl), 1, conf)
        self.assertEqual(sorted(acl[0].split()[3:]), sorted(UAT))
        hosts = set(acl[0].split()[3:])
        for f in PROD:
            self.assertNotIn(f, hosts)
            self.assertNotRegex(conf, r"(?<![\w.-])" + re.escape(f) + r"(?![\w.-])")
        self.assertRegex(conf, r"(?m)^http_access allow CONNECT lims_src lims_allowed_dst$")
        self.assertRegex(conf, r"(?m)^http_access deny all$")


# ============================================================================ egress_probe.sh payments (done_when, deploy-time)
WHO = "worker-a-1"
UAT_L, PROD_L = ",".join(UAT), ",".join(PROD)


class EgressProbePayments(unittest.TestCase):
    SCRIPT = "egress_probe.sh"
    ENV = {"PAYMENTS_ALLOWED_FQDNS": UAT_L, "PAYMENTS_DENIED_FQDNS": PROD_L + ",pay.fonepay.example"}
    DENIED = PROD + ["pay.fonepay.example"]

    def setUp(self):
        self.fake = Fake()
        self.addCleanup(self.fake.close)

    def good_http(self):
        h = {WHO + ">" + f: "200" for f in UAT}
        h.update({WHO + ">" + f: "403" for f in self.DENIED})
        return h

    def go(self, reach=(), http=None, env=None, tools=("nc", "curl"), running=True, args=None):
        st = {"containers": {WHO: {"running": running, "tools": list(tools), "inspect": {}}},
              "reach": [WHO + ">" + r for r in reach], "http": self.good_http() if http is None else http, "images": []}
        e = dict(self.ENV)
        e.update(env or {})
        return self.fake.run(self.SCRIPT, args or ["payments", WHO], st, e)

    def test_ok(self):
        need_script(self.SCRIPT)
        r = self.go()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_each_allowed_must_answer(self):
        need_script(self.SCRIPT)
        for f in UAT:
            for bad in ("000", "403", "407", "502"):
                h = self.good_http()
                h[WHO + ">" + f] = bad
                self.assertEqual(self.go(http=h).returncode, 1, "allowed %s answering %s" % (f, bad))

    def test_each_denied_must_be_403(self):  # "and nothing else": prod hosts and other gateways stay blocked from staging
        need_script(self.SCRIPT)
        for f in self.DENIED:
            for bad in ("200", "000", "407", "502"):
                h = self.good_http()
                h[WHO + ">" + f] = bad
                self.assertEqual(self.go(http=h).returncode, 1, "denied %s answering %s" % (f, bad))

    def test_direct_egress_must_be_closed(self):
        need_script(self.SCRIPT)
        for leak in ("1.1.1.1:443", "8.8.8.8:53", "169.254.169.254:80"):
            self.assertEqual(self.go(reach=[leak]).returncode, 1, leak)

    def test_cannot_pass_vacuously(self):
        need_script(self.SCRIPT)
        self.assertEqual(self.go(running=False).returncode, 1)
        self.assertEqual(self.go(tools=("nc",)).returncode, 1, "no curl")
        self.assertEqual(self.go(tools=("curl",)).returncode, 1, "no nc")
        self.assertEqual(self.go(http={}).returncode, 1, "nothing answers")

    def test_usage(self):
        need_script(self.SCRIPT)
        self.assertEqual(self.go(env={"PAYMENTS_ALLOWED_FQDNS": ""}).returncode, 2)
        self.assertEqual(self.go(env={"PAYMENTS_DENIED_FQDNS": ""}).returncode, 2)
        self.assertEqual(self.go(args=["payments"]).returncode, 2, "container name required")

    def test_script_parses_and_other_modes_survive(self):
        p = need_script(self.SCRIPT)
        r = subprocess.run([bash(), "-n", str(p)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.go(args=["bogus", WHO]).returncode, 2)
        self.assertIn("payments", p.read_text(encoding="utf-8"))


# ============================================================================ payments_kek (CR-C15-008 item 5)
def kek_section():
    t = need(RUNBOOK)
    m = re.search(r"(?ms)^## Payments KEK\s*\n(.*?)(?=^## |\Z)", t)
    if not m:
        raise AssertionError("secrets.md: section `## Payments KEK` (anchor #payments-kek) missing")
    return m.group(1)


class PaymentsKek(unittest.TestCase):
    def test_schema_every_env(self):
        for env in ("dev", "staging", "prod"):
            d = yaml.safe_load(need(SCHEMAS / ("%s.secrets.schema.yaml" % env)))
            items = d if isinstance(d, list) else next(v for v in d.values() if isinstance(v, list))
            k = [x for x in items if isinstance(x, dict) and x.get("id") == "payments_kek"]
            self.assertEqual(len(k), 1, env)
            self.assertEqual(set(k[0]["consumers"]), {"api-a", "api-b", "worker-a", "worker-b"}, env)
            self.assertRegex(k[0]["mount"], r"LIMS_PAYMENTS_KEK_FILE.*read-only", env)
            self.assertEqual(k[0]["owner"], "C15")

    def test_runbook_order(self):
        s = kek_section()
        pos = [s.lower().find(x) for x in ("add", "active", "payments.rewrap_credentials", "remove")]
        self.assertTrue(all(p >= 0 for p in pos) and pos == sorted(pos), "add -> active -> rewrap -> remove order: %s" % pos)
        self.assertRegex(s, r"(?i)never remove the old")

    def test_runbook_distinct_per_environment(self):  # CR item 5: "per environment, distinct keys"
        self.assertRegex(kek_section(), r"(?is)(distinct|different|separate)[^.]*\b(environment|env)\b|\b(environment|env)\b[^.]*(distinct|different|separate)")

    def test_runbook_kek_never_in_database(self):  # D-118
        self.assertRegex(kek_section(), r"(?is)\b(never|not)\b[^.]*\b(database|DB)\b|\b(database|DB)\b[^.]*\b(never|not)\b")

    def test_runbook_no_secret_values(self):
        self.assertNotRegex(kek_section(), r"[A-Za-z0-9+/]{40,}={0,2}", "no key material in the runbook")


if __name__ == "__main__":
    unittest.main()
