"""T-25 tests (tester role): fail2ban jails + filters + ban metrics (02-TRD s6.8; 06-PLAN row T-25).

ACs: AC-04.4, AC-04.4a, AC-04.5, AC-04.6, AC-04.7. Security: 07-SECURITY REQ-SEC-132, AB-2, AB-2a. LD-45: no host name in a
file; the jail file renders for every inventory's `wg_subnet`; both topology profiles use the same edge files.

HOW: fail2ban is not installed on the test host, so this module (a) parses the committed jail/filter files with configparser,
(b) builds access.json lines from the REAL `log_format lims_json` in infra/edge/nginx/snippets/logformat.conf, (c) applies each
filter's `failregex`/`ignoreregex` with Python `re` (fail2ban's own engine; `<HOST>` expanded like fail2ban does), (d) replays
fail2ban's counting rule - a ban when >= `maxretry` matches from one address fall inside `findtime` - with the jail's own
numbers, honouring `ignoreip`. The AC scenarios are replayed exactly as written (20/19 rejections, 300/299, 501-request agent
bursts, 600 failed logins at 1/s, 30 agent 404s...). Real engine: `fail2ban-regex` is used too when it is on PATH (else skipped).
The real nginx replay of the same ACs against a live edge: infra/tests/external/bans.py (syntax + fail-closed checked here).

CONTRACTS where the spec is silent (writer meets them or files a dispute; nothing here is a silent design change):
 * Files (all under infra/edge/fail2ban/): jail.d/lims.local, filter.d/lims-ratelimit.conf, filter.d/lims-auth.conf,
   fail2ban_metrics.sh. NO filter.d/lims-scan*, NO jail named lims-scan (08 A25 D-211).
 * jail.d/lims.local is INI and may use Jinja2 with ONLY `wg_subnet` (and wg_ip, inventory_hostname) - an undefined variable
   in a render = FAIL. Its `ignoreip` must cover 127.0.0.0/8, ::1 and the whole `wg_subnet` and nothing else (wg0 never banned).
   Sections: [sshd] (backend=systemd, 5 / 10 min / 1 h), [lims-ratelimit] (20 / 10 min / 1 h), [lims-auth] (300 / 10 min / 15 min).
   `logpath = /var/log/nginx/access.json`, `banaction = nftables-multiport` (DEFAULT or per jail), no `bantime.increment`.
 * Filters are self-contained (no `[INCLUDES]`/`before`), define `failregex` (one regex per line, `<HOST>` = remote_addr) and a
   `datepattern`. They match the nginx JSON line: "status":"429" AND "limit_req_status":"REJECTED" AND a "route" test:
     lims-auth       : route is a `login`-zone route: ^/auth/(login|mfa|mfa/enrol|forgot|confirm|set-password)$ or
                       /v1/identity/mobile/sessions (prefix, 02-TRD s6.5);
     lims-ratelimit  : route is none of the login routes above, nor `agent` (/v1/instruments/agent/ prefix), `otp`
                       (/v1/engagement/auth/otp-challenges prefix) or `psession` (= /v1/identity/auth/patient/session/resolve).
   Anchored: `/auth/loginx`, `/auth/login/`, `/x/auth/login`, `/v1/instruments/agent` (no slash) are NOT login/agent routes.
   `limit_req_status` PASSED (app-generated 429), REJECTED_DRY_RUN, and every 401/404/5xx line never match either filter.
 * fail2ban_metrics.sh [bash; env TEXTFILE_DIR, default stdout when unset; `fail2ban-client` from PATH]: for each jail
   sshd, lims-ratelimit, lims-auth exports counter `lims_ops_fail2ban_bans_total{jail="<jail>"} <Total banned>` (0 when quiet) to
   $TEXTFILE_DIR/fail2ban.prom (atomic, no stray temp file). Client addresses are never output. fail2ban unreachable: exit 1, no
   sample, stale fail2ban.prom removed (never a healthy 0). Non-numeric counts are never written.
 * infra/ansible/roles/fail2ban: tasks/main.yml installs fail2ban, TEMPLATES jail.d/lims.local, copies filter.d/lims-*.conf from
   infra/edge/fail2ban, validates with `fail2ban-client -t`, installs the metrics script + a timer/cron into
   /var/lib/node_exporter/textfile; handlers/main.yml restarts/reloads fail2ban. playbooks/site.yml: role `fail2ban` in the
   `app`-host play after `edge_nginx`.
 * infra/tests/external/bans.py: exits 2 and sends nothing when LIMS_F2B_CMD / LIMS_TEST_SOURCE_IPS are unset (compiles too).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t25_*.py" -v
"""
import configparser
import functools
import datetime as dt
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
F2B = ROOT / "infra" / "edge" / "fail2ban"
JAIL = F2B / "jail.d" / "lims.local"
FILT = F2B / "filter.d"
METRICS_SH = F2B / "fail2ban_metrics.sh"
LOGFMT = ROOT / "infra" / "edge" / "nginx" / "snippets" / "logformat.conf"
ROLE = ROOT / "infra" / "ansible" / "roles" / "fail2ban"
SITE_YML = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
SEC_RULES = ROOT / "infra" / "monitoring" / "rules" / "security.rules.yml"
BANS_PY = ROOT / "infra" / "tests" / "external" / "bans.py"
INVENTORIES = ROOT / "infra" / "ansible" / "inventories"
HOSTNAME_RE = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")
WG_SUBNETS = {"dev": "10.79.0.0/24", "staging": "10.78.0.0/24", "prod": "10.77.0.0/24"}  # inventories/*/group_vars/all.yml
METRIC = "lims_ops_fail2ban_bans_total"

LOGIN_ROUTES = ["/auth/login", "/auth/mfa", "/auth/mfa/enrol", "/auth/forgot", "/auth/confirm", "/auth/set-password",
                "/v1/identity/mobile/sessions", "/v1/identity/mobile/sessions/refresh"]
AGENT_ROUTES = ["/v1/instruments/agent/", "/v1/instruments/agent/attachments", "/v1/instruments/agent/message-batches",
                "/v1/instruments/agent/no-such-thing"]
OTP_ROUTES = ["/v1/engagement/auth/otp-challenges", "/v1/engagement/auth/otp-challenges/abc/verify"]
# psession routes come from the generated edge route table (zone field), so a new psession route can't be missed (review item 2)
PSESSION_ROUTES = sorted(r["path"] for r in yaml.safe_load(
    (ROOT / "infra" / "edge" / "public-routes.yaml").read_text(encoding="utf-8"))["routes"] if r["zone"] == "psession")
EXEMPT_FROM_RATELIMIT = LOGIN_ROUTES + AGENT_ROUTES + OTP_ROUTES + PSESSION_ROUTES
# Routes whose rejections come from perip / callback / payments / qrverify (the logged route is $uri or a template).
COUNTED_BY_RATELIMIT = ["/v1/payments/result", "/v1/payments/launch/:token", "/v1/payments/callbacks/khalti/:token",
                        "/v1/reporting/provider-callbacks/{token}", "/v/{token}", "/", "/v1/lab/orders",
                        "/auth/loginx", "/auth/login/", "/x/auth/login", "/auth/login-x", "/v1/instruments/agent",
                        "/v1/instruments/agents/x", "/v1/identity/mobile", "/zzz/v1/instruments/agent/x"]
BASE = dt.datetime(2026, 11, 8, 3, 0, 0, tzinfo=dt.timezone(dt.timedelta(hours=5, minutes=45)))


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def uncommented(text):
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith(("#", ";")))


def secs(v):
    """fail2ban time abbreviations: 600, 10m, 10min, 1h, 15m, 1d."""
    m = re.fullmatch(r"\s*(\d+)\s*(s|sec|m|min|h|hour|d|day)?s?\s*", str(v))
    if not m:
        raise AssertionError("bad fail2ban time %r" % v)
    return int(m.group(1)) * {None: 1, "s": 1, "sec": 1, "m": 60, "min": 60, "h": 3600, "hour": 3600, "d": 86400, "day": 86400}[m.group(2)]


# ----------------------------------------------------------------------------------------------- jail / filter loading
class _Undef(jinja2.StrictUndefined):
    pass


def render_jail(wg_subnet="10.77.0.0/24"):
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
    text = env.from_string(need(JAIL)).render(wg_subnet=wg_subnet, wg_ip=str(ipaddress.ip_network(wg_subnet)[11]),
                                              inventory_hostname="host-under-test")
    return text


def parse_ini(text):
    cp = configparser.ConfigParser(interpolation=None, strict=False, delimiters=("=",), inline_comment_prefixes=None)
    cp.optionxform = str
    cp.read_string(text)
    return cp


@functools.lru_cache(maxsize=None)
def jail_cfg(wg_subnet="10.77.0.0/24"):
    cp = parse_ini(render_jail(wg_subnet))
    return cp


def jopt(cp, jail, key, default=None):
    if cp.has_section(jail) and cp.has_option(jail, key):
        return cp.get(jail, key).strip()
    if cp.defaults().get(key) is not None:
        return cp.defaults()[key].strip()
    return default


def ignore_nets(cp, jail):
    raw = jopt(cp, jail, "ignoreip", "") or ""
    out = []
    for tok in re.split(r"[\s,]+", raw):
        if tok:
            out.append(ipaddress.ip_network(tok, strict=False))
    return out


HOST_RE = r"(?:::f{4,6}:)?(?P<host>[0-9a-fA-F:.]+)"   # fail2ban's <HOST>, simplified (v4 / v6 / mapped)


class Filter:
    def __init__(self, name):
        self.name = name
        text = need(FILT / ("%s.conf" % name))
        cp = parse_ini(text)
        if not cp.has_section("Definition"):
            raise AssertionError("%s.conf needs a [Definition] section" % name)
        self.cp, self.text = cp, text
        d = cp["Definition"]
        self.fail = self._rx(d.get("failregex", ""))
        self.ignore = self._rx(d.get("ignoreregex", ""))
        if not self.fail:
            raise AssertionError("%s.conf: failregex is empty" % name)

    @staticmethod
    def _rx(block):
        out = []
        for ln in block.splitlines():
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            ln = re.sub(r"</?F-[A-Z0-9_]+>", "", ln).replace("<HOST>", HOST_RE)
            out.append(re.compile(ln))
        return out

    def host(self, line):
        """Address fail2ban would count, or None."""
        for rx in self.ignore:
            if rx.search(line):
                return None
        for rx in self.fail:
            m = rx.search(line)
            if m:
                return m.group("host") if "host" in m.groupdict() else None
        return None


_FILTERS = {}


def filt(name):
    if name not in _FILTERS:
        _FILTERS[name] = Filter(name)
    return _FILTERS[name]


# ----------------------------------------------------------------------------------------------- log lines from the real format
@functools.lru_cache(maxsize=None)
def _template():
    m = re.search(r"log_format\s+lims_json\s+escape=json\s+'([^']*)'", need(LOGFMT))
    if not m:
        raise AssertionError("logformat.conf: log_format lims_json escape=json '...' not found")
    return m.group(1)


def _esc(v):
    return json.dumps(str(v), ensure_ascii=False)[1:-1]   # what nginx escape=json does to a value


def mkline(ip, route, status="429", lrs="REJECTED", t=0.0, method="POST", host="lab.example.test", ua="browser"):
    ts = (BASE + dt.timedelta(seconds=t)).isoformat(timespec="seconds")
    vals = {"time_iso8601": ts, "request_id": "0192b2e6" + "%024x" % int(t * 1000), "remote_addr": ip, "host": host,
            "request_method": method, "route": route, "status": status, "body_bytes_sent": "0", "request_time": "0.000",
            "upstream_response_time": "-", "upstream_status": "-", "ua_class": ua, "limit_req_status": lrs}
    return re.sub(r"\$([a-z_0-9]+)", lambda m: _esc(vals.get(m.group(1), "-")), _template())


def rej(ip, route, n, t0=0.0, span=540.0, **kw):
    """n limit_req rejections (429 REJECTED) evenly spread over `span` seconds starting at t0."""
    step = span / max(n - 1, 1)
    return [(t0 + i * step, mkline(ip, route, t=t0 + i * step, **kw)) for i in range(n)]


def bans(jail, events, wg_subnet="10.77.0.0/24"):
    """Replay fail2ban counting for `jail` over [(t, line)]: set of addresses banned."""
    cp = jail_cfg(wg_subnet)
    f = filt(jopt(cp, jail, "filter", jail))
    maxretry, findtime = int(jopt(cp, jail, "maxretry")), secs(jopt(cp, jail, "findtime"))
    nets = ignore_nets(cp, jail)
    hits = {}
    for t, line in sorted(events, key=lambda e: e[0]):
        h = f.host(line)
        if h is None:
            continue
        try:
            ip = ipaddress.ip_address(h)
        except ValueError:
            continue    # fail2ban's <HOST> only yields valid addresses
        if any(ip in n for n in nets if n.version == ip.version):
            continue
        hits.setdefault(h, []).append(t)
    banned = set()
    for h, ts in hits.items():
        j = 0
        for i, t in enumerate(ts):
            while t - ts[j] >= findtime:
                j += 1
            if i - j + 1 >= maxretry:
                banned.add(h)
                break
    return banned


def all_bans(events, **kw):
    return {j: bans(j, events, **kw) for j in ("lims-ratelimit", "lims-auth")}


IP = "203.0.113.7"
IP2 = "203.0.113.8"


# ----------------------------------------------------------------------------------------------- 1. files + jail config
class JailFileTest(unittest.TestCase):
    def test_files_exist_and_no_scan_jail(self):  # 08 A25 D-211: the 404 jail is deleted
        for p in (JAIL, FILT / "lims-ratelimit.conf", FILT / "lims-auth.conf", METRICS_SH):
            need(p)
        self.assertEqual(sorted(p.name for p in FILT.glob("lims-scan*")), [])
        cp = parse_ini(render_jail())
        self.assertNotIn("lims-scan", cp.sections())
        self.assertEqual(sorted(s for s in cp.sections()), ["lims-auth", "lims-ratelimit", "sshd"],
                         "exactly the sshd, lims-ratelimit and lims-auth jails (no jail counts 404s/401s)")
        self.assertNotRegex(uncommented(need(JAIL)), r"lims-scan|\b404\b|\b401\b")

    def test_thresholds(self):  # 02-TRD s6.8 [CONV]
        cp = jail_cfg()
        want = {"sshd": (5, 600, 3600), "lims-ratelimit": (20, 600, 3600), "lims-auth": (300, 600, 900)}
        for j, (mr, ft, bt) in want.items():
            self.assertEqual(jopt(cp, j, "enabled", "").lower(), "true", j)
            self.assertEqual(int(jopt(cp, j, "maxretry")), mr, "%s maxretry" % j)
            self.assertEqual(secs(jopt(cp, j, "findtime")), ft, "%s findtime" % j)
            self.assertEqual(secs(jopt(cp, j, "bantime")), bt, "%s bantime" % j)

    def test_log_sources_and_action(self):
        cp = jail_cfg()
        self.assertEqual(jopt(cp, "sshd", "backend"), "systemd", "sshd reads journald")
        for j in ("lims-ratelimit", "lims-auth"):
            self.assertEqual(jopt(cp, j, "logpath"), "/var/log/nginx/access.json", j)
            self.assertNotEqual(jopt(cp, j, "backend", "auto"), "systemd", "%s reads a file" % j)
            self.assertEqual(jopt(cp, j, "filter"), j)
        for j in ("sshd", "lims-ratelimit", "lims-auth"):
            self.assertEqual(jopt(cp, j, "banaction"), "nftables-multiport", "%s: bans are nftables set entries" % j)
        for j in ("sshd", "lims-ratelimit", "lims-auth"):
            self.assertNotIn(jopt(cp, j, "bantime.increment", "false").lower(), ("true", "yes", "1"), "fixed ban times")

    def test_wg0_never_banned(self):  # done_when: wg0 never banned (TRD s6.8)
        for env, sub in WG_SUBNETS.items():
            cp = jail_cfg(sub)
            wg = ipaddress.ip_network(sub)
            for j in ("sshd", "lims-ratelimit", "lims-auth"):
                nets = ignore_nets(cp, j)
                self.assertTrue(any(ipaddress.ip_network("127.0.0.0/8").subnet_of(n) for n in nets if n.version == 4), "%s/%s loopback" % (env, j))
                self.assertTrue(any(ipaddress.ip_network("::1/128").subnet_of(n) for n in nets if n.version == 6), "%s/%s ::1" % (env, j))
                self.assertTrue(any(wg.subnet_of(n) for n in nets if n.version == 4), "%s/%s: ignoreip must cover wg_subnet %s" % (env, j, sub))
                for n in nets:  # nothing else is exempt - a public range here would let an attacker flood unbanned
                    ok = n.subnet_of(ipaddress.ip_network("127.0.0.0/8")) if n.version == 4 and n.is_loopback else \
                        (n.subnet_of(wg) if n.version == 4 else n.is_loopback)
                    self.assertTrue(ok, "%s/%s: ignoreip %s is not loopback/wg0" % (env, j, n))

    def test_wg_subnets_match_the_inventories(self):  # guards this file's table against inventory drift
        for env, sub in WG_SUBNETS.items():
            d = yaml.safe_load((INVENTORIES / env / "group_vars" / "all.yml").read_text(encoding="utf-8"))
            self.assertEqual(d["wg_subnet"], sub, env)

    def test_no_host_names(self):  # LD-45
        for p in (JAIL, FILT / "lims-ratelimit.conf", FILT / "lims-auth.conf", METRICS_SH):
            self.assertIsNone(HOSTNAME_RE.search(need(p)), p.name)

    def test_wg_ignoreip_follows_the_variable_not_a_literal(self):  # a literal subnet would be wrong in two of three environments
        self.assertRegex(need(JAIL), r"\{\{\s*wg_subnet\s*\}\}")


class FilterFileTest(unittest.TestCase):
    def test_shape(self):
        for n in ("lims-ratelimit", "lims-auth"):
            f = filt(n)
            self.assertFalse(f.cp.has_section("INCLUDES"), "%s: self-contained (C1 writes all filters, TRD s6.8)" % n)
            self.assertNotIn("before", f.cp.defaults())
            self.assertTrue(f.cp["Definition"].get("datepattern", "").strip(), "%s: datepattern for the ts field" % n)
            self.assertTrue(all("host" in rx.groupindex for rx in f.fail), "every failregex line carries <HOST>")
            self.assertNotRegex(f.cp["Definition"]["failregex"], r"40[14]", "%s: no jail counts 401/404" % n)

    def test_real_engine_agrees_when_available(self):
        exe = shutil.which("fail2ban-regex")
        if not exe:
            self.skipTest("fail2ban-regex not installed (static simulation above is the proof here)")
        with tempfile.TemporaryDirectory() as td:
            log = Path(td) / "access.json"
            ev = rej(IP, "/auth/login", 3) + rej(IP2, "/v1/payments/result", 3) + rej(IP, "/auth/login", 2, status="401", lrs="PASSED")
            log.write_text("\n".join(l for _, l in ev) + "\n", encoding="utf-8")
            for n, want in (("lims-auth", 3), ("lims-ratelimit", 3)):
                r = subprocess.run([exe, str(log), str(FILT / ("%s.conf" % n))], capture_output=True, text=True, timeout=60)
                self.assertEqual(r.returncode, 0, r.stderr[-400:])
                self.assertRegex(r.stdout, r"Lines:\s*8 lines,\s*0 ignored,\s*%d matched" % want, n)


# ----------------------------------------------------------------------------------------------- 2. behaviour: AC-04.4 / .4a / .5 / .6 / .7
class RatelimitJailTest(unittest.TestCase):
    def test_ac_04_4_twenty_rejections_in_ten_minutes_ban(self):
        b = all_bans(rej(IP, "/v1/payments/result", 20, span=540))
        self.assertEqual(b["lims-ratelimit"], {IP})
        self.assertEqual(b["lims-auth"], set())

    def test_ac_04_4_nineteen_do_not(self):
        self.assertEqual(all_bans(rej(IP, "/v1/payments/result", 19, span=540)), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_4_twenty_spread_over_more_than_ten_minutes_do_not(self):
        self.assertEqual(bans("lims-ratelimit", rej(IP, "/v1/payments/result", 20, span=900)), set())

    def test_each_non_exempt_route_counts(self):
        for r in COUNTED_BY_RATELIMIT:
            self.assertEqual(bans("lims-ratelimit", rej(IP, r, 20)), {IP}, r)
            self.assertEqual(bans("lims-auth", rej(IP, r, 400)), set(), "%s must not feed lims-auth" % r)

    def test_ban_is_per_address(self):
        ev = rej(IP, "/v1/payments/result", 10) + rej(IP2, "/v1/payments/result", 10, t0=3) + rej(IP, "/", 10, t0=6)
        self.assertEqual(bans("lims-ratelimit", ev), {IP})   # IP has 20 in total, IP2 only 10
        self.assertEqual(bans("lims-ratelimit", rej("2001:db8::5", "/v1/payments/result", 20)), {"2001:db8::5"})

    def test_ban_ignores_the_log_order_of_other_addresses(self):
        noise = rej(IP2, "/", 19, span=500)
        self.assertEqual(bans("lims-ratelimit", noise + rej(IP, "/", 19, t0=1)), set())

    def test_only_429_rejected_lines_count(self):  # 401 / 404 / app 429 / dry run / other statuses never count
        cases = [("401", "PASSED"), ("401", "-"), ("404", "-"), ("404", "PASSED"), ("404", "REJECTED"), ("429", "PASSED"),
                 ("429", "DELAYED"), ("429", "REJECTED_DRY_RUN"), ("429", ""), ("429", "-"), ("503", "REJECTED"),
                 ("200", "PASSED"), ("500", "-")]
        for st, lrs in cases:
            self.assertEqual(all_bans(rej(IP, "/v1/payments/result", 400, span=500, status=st, lrs=lrs)),
                             {"lims-ratelimit": set(), "lims-auth": set()}, "%s/%s" % (st, lrs))

    def test_app_generated_429s_are_not_counted(self):  # C2 per-IP failure throttle: limit_req_status PASSED
        self.assertEqual(all_bans(rej(IP, "/auth/login", 400, status="429", lrs="PASSED")),
                         {"lims-ratelimit": set(), "lims-auth": set()})
        self.assertEqual(all_bans(rej(IP, "/v1/lab/orders", 400, status="429", lrs="PASSED")),
                         {"lims-ratelimit": set(), "lims-auth": set()})

    def test_passed_lines_do_not_help_reach_the_threshold(self):
        ev = rej(IP, "/", 19, span=400) + rej(IP, "/", 500, t0=1, span=400, status="429", lrs="PASSED")
        self.assertEqual(bans("lims-ratelimit", ev), set())


class ExemptZonesTest(unittest.TestCase):
    def test_ac_04_4a_three_hundred_agent_rejections_no_ban(self):
        # 501 requests at once -> ~300 rejected, then more bursts: 3 bursts in 10 minutes
        ev = rej(IP, "/v1/instruments/agent/message-batches", 300, t0=0, span=2) + \
             rej(IP, "/v1/instruments/agent/heartbeats", 300, t0=200, span=2) + rej(IP, "/v1/instruments/agent/attachments", 300, t0=400, span=2)
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_4a_hundred_otp_and_psession_rejections_no_ban(self):
        for r in OTP_ROUTES + PSESSION_ROUTES:
            self.assertEqual(all_bans(rej(IP, r, 100, span=60)), {"lims-ratelimit": set(), "lims-auth": set()}, r)
            self.assertEqual(all_bans(rej(IP, r, 400, span=500)), {"lims-ratelimit": set(), "lims-auth": set()}, r)

    def test_ac_04_4a_all_exempt_zones_together(self):
        ev = rej(IP, "/v1/instruments/agent/x", 300, span=500) + rej(IP, OTP_ROUTES[0], 100, span=500) + \
             rej(IP, PSESSION_ROUTES[0], 100, span=500)
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_psession_routes_include_resolve_and_logout(self):
        self.assertIn("/v1/identity/auth/patient/session/resolve", PSESSION_ROUTES)
        self.assertIn("/v1/identity/auth/patient/session/logout", PSESSION_ROUTES)

    def test_ac_04_4a_hundred_psession_logout_rejections_no_ban(self):
        ev = rej(IP, "/v1/identity/auth/patient/session/logout", 100, span=60)
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_exempt_rejections_do_not_add_to_the_countable_ones(self):  # 19 countable + 300 agent stays at 19
        ev = rej(IP, "/v1/payments/result", 19, span=500) + rej(IP, "/v1/instruments/agent/x", 300, span=500)
        self.assertEqual(bans("lims-ratelimit", ev), set())
        self.assertEqual(bans("lims-ratelimit", ev + rej(IP, "/v1/payments/result", 1, t0=520)), {IP})  # the 20th countable one bans

    def test_every_exempt_route_individually(self):
        for r in EXEMPT_FROM_RATELIMIT:
            self.assertEqual(bans("lims-ratelimit", rej(IP, r, 400, span=500)), set(), r)


class AuthJailTest(unittest.TestCase):
    def test_ac_04_5_three_hundred_login_rejections_ban(self):
        b = all_bans(rej(IP, "/auth/login", 300, span=540))
        self.assertEqual(b["lims-auth"], {IP})

    def test_ac_04_5_two_hundred_ninety_nine_do_not(self):
        self.assertEqual(all_bans(rej(IP, "/auth/login", 299, span=540)), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_5_login_rejections_never_trip_the_ratelimit_jail(self):  # lims-ratelimit must not pre-empt the 300 threshold
        for n in (20, 299, 300, 400):
            self.assertEqual(bans("lims-ratelimit", rej(IP, "/auth/login", n, span=540)), set(), n)

    def test_ac_04_5_every_login_zone_route_counts(self):
        for r in LOGIN_ROUTES:
            self.assertEqual(bans("lims-auth", rej(IP, r, 300)), {IP}, r)
            self.assertEqual(bans("lims-auth", rej(IP, r, 299)), set(), r)

    def test_ac_04_5_routes_add_up(self):
        ev = rej(IP, "/auth/login", 150, span=500) + rej(IP, "/auth/mfa", 100, span=500, t0=1) + rej(IP, "/v1/identity/mobile/sessions", 50, span=500, t0=2)
        self.assertEqual(bans("lims-auth", ev), {IP})
        self.assertEqual(bans("lims-auth", ev[:-1]), set())

    def test_ac_04_5_slower_than_ten_minutes_do_not(self):
        self.assertEqual(bans("lims-auth", rej(IP, "/auth/login", 300, span=1200)), set())

    def test_ac_04_5_non_login_routes_never_feed_lims_auth(self):
        for r in ["/v1/payments/result", "/", "/v1/instruments/agent/x", "/auth/loginx", "/auth/login/", "/x/auth/login", "/auth/login-x"]:
            self.assertEqual(bans("lims-auth", rej(IP, r, 400, span=500)), set(), r)

    def test_ac_04_5_login_401s_are_never_counted(self):  # 08 Addendum A3.2
        for lrs in ("PASSED", "-", "", "REJECTED", "DELAYED"):
            self.assertEqual(all_bans(rej(IP, "/auth/login", 400, span=500, status="401", lrs=lrs)),
                             {"lims-ratelimit": set(), "lims-auth": set()}, lrs)

    def test_ban_is_per_address_ipv6(self):
        ev = rej("2001:db8::9", "/auth/login", 300) + rej(IP2, "/auth/login", 299, t0=1)
        self.assertEqual(bans("lims-auth", ev), {"2001:db8::9"})


class AcceptanceScenarioTest(unittest.TestCase):
    @staticmethod
    def flood_guard(times, rate=1.0, burst=20):
        """ngx_http_limit_req: zone=login rate=60r/m (1 r/s) burst=20 nodelay -> request times that are rejected."""
        excess, last, rejected = 0.0, None, []
        for t in times:
            ex = 0.0 if last is None else max(0.0, excess - (t - last) * rate + 1.0)
            if ex > burst:
                rejected.append(t)      # a rejected request does not change the state
                continue
            excess, last = ex, t
        return rejected

    def test_ac_04_6_sixty_failed_logins_a_minute_for_ten_minutes_no_ban(self):
        times = [float(i) for i in range(600)]                 # 600 POSTs, one per second
        self.assertEqual(self.flood_guard(times), [], "the 60 req/min flood guard rejects none of them (AC-04.6)")
        ev = []
        for i, t in enumerate(times):
            if i < 10:     # first failures answered 401 by the app ...
                ev.append((t, mkline(IP, "/auth/login", status="401", lrs="PASSED", t=t)))
            else:          # ... then C2's per-IP failure throttle answers app-generated 429s
                ev.append((t, mkline(IP, "/auth/login", status="429", lrs="PASSED", t=t)))
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})
        ev401 = [(t, mkline(IP, "/auth/login", status="401", lrs="PASSED", t=t)) for t in times]
        self.assertEqual(all_bans(ev401), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_6_positive_control_a_real_flood_is_banned(self):  # proves the replay above is not vacuous
        times = [i * 0.5 for i in range(1200)]                  # 2 req/s for 10 min
        rejected = set(self.flood_guard(times))
        self.assertGreaterEqual(len(rejected), 300)
        ev = [(t, mkline(IP, "/auth/login", status="429" if t in rejected else "401",
                         lrs="REJECTED" if t in rejected else "PASSED", t=t)) for t in times]
        self.assertEqual(bans("lims-auth", ev), {IP})
        self.assertEqual(bans("lims-ratelimit", ev), set())

    def test_ac_04_7_thirty_agent_404s_in_five_minutes_no_ban(self):
        ev = [(i * 10.0, mkline(IP, "/v1/instruments/agent/nosuch-%d" % i, status="404", lrs="PASSED", t=i * 10.0, method="GET", ua="bridge-agent"))
              for i in range(30)]
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_7_sustained_404s_for_fifteen_minutes_still_no_ban(self):  # > 30 per 5 min for 15 min (EdgeNotFoundSpike fires, no ban)
        ev = [(i * 5.0, mkline(IP, "/v1/instruments/agent/nosuch-%d" % i, status="404", lrs=lrs, t=i * 5.0, method="GET"))
              for i, lrs in zip(range(180), ["PASSED", "-"] * 90)]
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})

    def test_ac_04_7_a_thousand_404s_anywhere_no_ban(self):
        for r in ("/wp-login.php", "/.env", "/v1/instruments/agent/x", "/auth/login", "/"):
            ev = [(i * 0.5, mkline(IP, r, status="404", lrs=lrs, t=i * 0.5, method="GET"))
                  for i, lrs in zip(range(400), ["PASSED", "-", "", "REJECTED"] * 100)]
            self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()}, r)

    def test_wg0_addresses_are_never_banned(self):
        for env, sub in WG_SUBNETS.items():
            wg = str(ipaddress.ip_network(sub)[12])
            for jail, route, n in (("lims-ratelimit", "/v1/payments/result", 200), ("lims-auth", "/auth/login", 400)):
                self.assertEqual(bans(jail, rej(wg, route, n), wg_subnet=sub), set(), "%s %s" % (env, jail))
            self.assertEqual(bans("lims-ratelimit", rej("127.0.0.1", "/", 200)), set())
            self.assertEqual(bans("lims-ratelimit", rej("::1", "/", 200)), set())
            outside = str(ipaddress.ip_network(sub)[0] + 256)
            self.assertEqual(bans("lims-ratelimit", rej(outside, "/", 20), wg_subnet=sub), {outside},
                             "an address just outside wg_subnet is not exempt")


class AdversarialLogTest(unittest.TestCase):
    """The client controls $uri, $host and the user agent; a line must be classified by the real fields only."""

    def test_route_text_cannot_spoof_an_exempt_zone(self):
        for evil in ('/x","route":"/v1/instruments/agent/y', '/x\\","route\\":\\"/auth/login', '/a"b/v1/instruments/agent/',
                     "/x\n/v1/instruments/agent/", '/x","limit_req_status":"PASSED', '/v1/payments/result"}{"status":"401'):
            self.assertEqual(bans("lims-ratelimit", rej(IP, evil, 20)), {IP}, repr(evil))

    def test_host_header_cannot_forge_an_address_or_status(self):
        host = 'x","remote_addr":"198.51.100.99","status":"429","limit_req_status":"REJECTED","route":"/v1/payments/result'
        ev = rej(IP, "/v1/instruments/agent/x", 400, host=host) + rej(IP2, "/v1/instruments/agent/x", 400, host=host, status="404", lrs="-")
        self.assertEqual(all_bans(ev), {"lims-ratelimit": set(), "lims-auth": set()})
        self.assertEqual(bans("lims-ratelimit", rej(IP, "/v1/payments/result", 20, host=host)), {IP}, "only the real remote_addr is banned")

    def test_garbage_lines_are_ignored_not_fatal(self):
        junk = ["", "\x00\x01\x02", "not json", "{", '{"status":"429"}', '{"remote_addr":"","status":"429","limit_req_status":"REJECTED"}',
                '{"remote_addr":"not-an-ip","status":"429","limit_req_status":"REJECTED","route":"/"}', "\u202e" * 500]
        for jail in ("lims-ratelimit", "lims-auth"):
            self.assertEqual(bans(jail, [(i, l) for i, l in enumerate(junk * 30)]), set(), jail)

    def test_pathological_lines_are_fast(self):  # ReDoS guard: the log is attacker-fed
        lines = [mkline(IP, "/" + "a" * 4000 + "\"" * 300 + "\\" * 300, t=i) for i in range(100)]
        lines += [mkline(IP, "/auth/" + "login" * 800, t=i) for i in range(100)]
        lines += ['{"remote_addr":"%s","status":"429",' % IP + '"limit_req_status":"REJECTED"' * 400 for _ in range(50)]
        for n in ("lims-ratelimit", "lims-auth"):
            f = filt(n)
            t0 = time.time()
            for l in lines:
                f.host(l)
            self.assertLess(time.time() - t0, 3.0, "%s: catastrophic backtracking on hostile input" % n)


# ----------------------------------------------------------------------------------------------- 3. ban metrics
def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


FAKE_CLIENT = r"""#!/usr/bin/env bash
echo "$*" >> "$FIX/client.log"
if [ -f "$FIX/down" ]; then echo "ERROR  Failed to access socket path: /var/run/fail2ban/fail2ban.sock" >&2; exit 255; fi
if [ "$1" = "status" ] && [ -z "${2:-}" ]; then
  printf 'Status\n|- Number of jail:\t3\n`- Jail list:\tsshd, lims-ratelimit, lims-auth\n'; exit 0
fi
if [ "$1" = "status" ] && [ -f "$FIX/status_$2.txt" ]; then cat "$FIX/status_$2.txt"; exit 0; fi
echo "Sorry but the jail '$2' does not exist" >&2; exit 255
"""


def status_text(jail, total, banned="203.0.113.7 2001:db8::1"):
    return ("Status for the jail: %s\n|- Filter\n|  |- Currently failed:\t0\n|  |- Total failed:\t999\n"
            "|  `- File list:\t/var/log/nginx/access.json\n`- Actions\n   |- Currently banned:\t1\n"
            "   |- Total banned:\t%s\n   `- Banned IP list:\t%s\n" % (jail, total, banned))


class MetricsScriptTest(unittest.TestCase):
    def setUp(self):
        self.assertTrue(METRICS_SH.is_file(), "missing infra/edge/fail2ban/fail2ban_metrics.sh")
        self.tmp = Path(tempfile.mkdtemp(prefix="t25-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin, self.out = self.tmp / "bin", self.tmp / "out"
        self.bin.mkdir()
        self.out.mkdir()
        (self.bin / "fail2ban-client").write_bytes(FAKE_CLIENT.replace("\r\n", "\n").encode())

    def run_script(self, totals=None, down=False, old=None, textfile=True, extra=None):
        for j, n in (totals if totals is not None else {"sshd": 2, "lims-ratelimit": 5, "lims-auth": 0}).items():
            (self.tmp / ("status_%s.txt" % j)).write_text(status_text(j, n), encoding="utf-8", newline="\n")
        if down:
            (self.tmp / "down").write_text("1")
        if old is not None:
            (self.out / "fail2ban.prom").write_text(old, encoding="utf-8")
        env = dict(os.environ, FIX=self.tmp.as_posix(), **(extra or {}))
        if textfile:
            env["TEXTFILE_DIR"] = self.out.as_posix()
        else:
            env.pop("TEXTFILE_DIR", None)
        # Git Bash's login profile prepends /mingw64/bin: put the fake first inside the shell (same fix as T-19 ruling).
        cmd = ("command -v cygpath >/dev/null && B=\"$(cygpath -u '%s')\" || B='%s'; export PATH=\"$B:$PATH\"; "
               "cd '%s' && bash '%s'" % (str(self.bin), self.bin.as_posix(), ROOT.as_posix(), METRICS_SH.as_posix()))
        r = subprocess.run([_bash(), "-c", cmd], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        f = self.out / "fail2ban.prom"
        return r, (f.read_text(encoding="utf-8") if f.exists() else ""), r.stdout

    @staticmethod
    def samples(text):
        return [l for l in text.splitlines() if l.strip() and not l.startswith("#")]

    def values(self, text):
        out = {}
        for l in self.samples(text):
            m = re.fullmatch(METRIC + r'\{jail="([a-z0-9-]+)"\}\s+(\d+)', l)
            self.assertIsNotNone(m, "unexpected sample line %r" % l)
            out[m.group(1)] = int(m.group(2))
        return out

    def test_file_shape(self):
        raw = METRICS_SH.read_bytes()
        self.assertTrue(raw.startswith(b"#!/usr/bin/env bash") or raw.startswith(b"#!/bin/bash"))
        self.assertNotIn(b"\r\n", raw, "CRLF breaks bash")
        r = subprocess.run([_bash(), "-n", METRICS_SH.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_exports_total_banned_per_jail(self):
        r, t, _ = self.run_script({"sshd": 2, "lims-ratelimit": 5, "lims-auth": 7})
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.values(t), {"sshd": 2, "lims-ratelimit": 5, "lims-auth": 7})
        self.assertIn("# TYPE %s counter" % METRIC, t)

    def test_quiet_jails_export_zero_not_absent(self):  # increase() needs the series to exist before the first ban
        r, t, _ = self.run_script({"sshd": 0, "lims-ratelimit": 0, "lims-auth": 0})
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(self.values(t), {"sshd": 0, "lims-ratelimit": 0, "lims-auth": 0})

    def test_the_security_alert_selects_this_series(self):  # AC-04.5: LimsAuthJailBan fires on increase of this exact series
        rules = yaml.safe_load(need(SEC_RULES))
        exprs = [r["expr"] for g in rules["groups"] for r in g["rules"] if r.get("alert") == "LimsAuthJailBan"]
        self.assertEqual(len(exprs), 1)
        self.assertIn('%s{jail="lims-auth"}' % METRIC, exprs[0])
        r, t, _ = self.run_script()
        self.assertIn('%s{jail="lims-auth"} ' % METRIC, t)
        self.assertNotRegex(t, r'jail="(?!sshd|lims-ratelimit|lims-auth)')

    def test_client_addresses_never_leave_the_host(self):
        r, t, o = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        for s in (t, o, r.stderr):
            self.assertNotRegex(s, r"\d+\.\d+\.\d+\.\d+")
            self.assertNotIn("2001:db8", s)
        self.assertEqual(sorted(self.values(t)), ["lims-auth", "lims-ratelimit", "sshd"])

    def test_fail2ban_down_exports_nothing_and_removes_stale_file(self):  # never a healthy-looking value for a dead exporter
        r, t, _ = self.run_script(down=True, old='%s{jail="lims-auth"} 3\n' % METRIC)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(t, "")
        self.assertEqual(list(self.out.iterdir()), [])

    def test_non_numeric_count_is_never_written(self):  # trust boundary: client output
        r, t, o = self.run_script({"sshd": 1, "lims-ratelimit": "abc; rm -rf /", "lims-auth": 2})
        self.assertNotIn("abc", t + o)
        self.assertNotIn("rm -rf", t + o)
        if r.returncode == 0:
            self.assertNotIn("lims-ratelimit", self.values(t))
        else:
            self.assertEqual(t, "")

    def test_write_is_atomic_and_leaves_no_temp_file(self):
        r, t, _ = self.run_script(old="stale\n")
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual([p.name for p in self.out.iterdir()], ["fail2ban.prom"])
        self.assertNotIn("stale", t)

    def test_stdout_when_textfile_dir_unset(self):
        r, t, o = self.run_script(textfile=False)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertEqual(t, "")
        self.assertEqual(self.values(o), {"sshd": 2, "lims-ratelimit": 5, "lims-auth": 0})

    def test_only_reads_status_never_changes_bans(self):  # it must be safe to run every minute as any user with socket access
        self.run_script()
        log = (self.tmp / "client.log").read_text()
        self.assertNotRegex(log, r"\b(set|unban|banip|reload|stop|start|restart|flushlogs)\b")


# ----------------------------------------------------------------------------------------------- 4. role + playbook + live script
class RoleTest(unittest.TestCase):
    def role_text(self):
        parts = []
        for p in sorted(ROLE.rglob("*")):
            if p.is_file():
                parts.append(p.read_text(encoding="utf-8", errors="replace"))
        return "\n".join(parts)

    def test_role_files_parse(self):
        for rel in ("tasks/main.yml", "handlers/main.yml"):
            doc = yaml.safe_load(need(ROLE / rel))
            self.assertIsInstance(doc, list, rel)
            self.assertTrue(doc, rel)

    def test_role_installs_validates_and_templates_the_jail(self):
        tasks = yaml.safe_load(need(ROLE / "tasks" / "main.yml"))
        txt = self.role_text()
        self.assertRegex(txt, r"\bfail2ban\b")
        self.assertIn("/etc/fail2ban", txt)
        self.assertRegex(txt, r"jail\.d")
        self.assertRegex(txt, r"filter\.d")
        self.assertRegex(txt, r"edge/fail2ban", "files come from infra/edge/fail2ban (single source)")
        self.assertRegex(txt, r"fail2ban-client\s+(?:\S+\s+)*?-t(?:\s|$|\")", "config is validated before it is activated")
        jail_tasks = [t for t in tasks if "lims.local" in json.dumps(t)]
        self.assertTrue(jail_tasks)
        self.assertTrue(any("ansible.builtin.template" in t or "template" in t for t in jail_tasks), "lims.local is TEMPLATED (wg_subnet)")
        self.assertIn("lims-", txt)
        self.assertNotIn("lims-scan", uncommented(txt))

    def test_role_notifies_a_fail2ban_handler(self):
        h = yaml.safe_load(need(ROLE / "handlers" / "main.yml"))
        self.assertTrue(any("fail2ban" in json.dumps(x) and re.search(r"restarted|reloaded|reload|restart", json.dumps(x)) for x in h))
        self.assertIn("notify", json.dumps(yaml.safe_load(need(ROLE / "tasks" / "main.yml"))))

    def test_role_schedules_the_metrics_script_into_the_node_exporter_textfile_dir(self):
        txt = self.role_text()
        self.assertIn("fail2ban_metrics", txt)
        self.assertIn("/var/lib/node_exporter/textfile", txt)
        self.assertRegex(txt, r"\.timer|cron|OnCalendar|OnUnitActiveSec")

    def test_role_has_no_host_names(self):  # LD-45
        self.assertIsNone(HOSTNAME_RE.search(self.role_text()))

    def test_site_yml_runs_the_role_on_the_app_play_after_edge_nginx(self):
        plays = yaml.safe_load(need(SITE_YML))
        hit = [p for p in plays if "fail2ban" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertEqual(len(hit), 1, "role fail2ban must be in exactly one play of site.yml")
        roles = [r if isinstance(r, str) else r.get("role") for r in hit[0]["roles"]]
        self.assertEqual(hit[0]["hosts"], "app")
        self.assertIn("edge_nginx", roles)
        self.assertGreater(roles.index("fail2ban"), roles.index("edge_nginx"))


class LiveScriptTest(unittest.TestCase):
    def test_bans_py_exists_compiles_and_fails_closed(self):
        src = need(BANS_PY)
        compile(src, str(BANS_PY), "exec")
        env = {k: v for k, v in os.environ.items() if not k.startswith("LIMS_")}
        r = subprocess.run([sys.executable, "-B", str(BANS_PY)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 2, "no config -> exit 2 and no request sent: %r" % r.stderr[-300:])
        env["LIMS_ORIGIN_API"] = "api.invalid"
        r = subprocess.run([sys.executable, "-B", str(BANS_PY)], env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)
        self.assertEqual(r.returncode, 2, "LIMS_F2B_CMD and LIMS_TEST_SOURCE_IPS are required")
        for ac in ("AC-04.4", "AC-04.4a", "AC-04.5", "AC-04.7"):
            self.assertIn(ac, src)
        self.assertIn("LIMS_F2B_CMD", src)
        self.assertIn("unbanip", src, "the script cleans up the bans it caused")


if __name__ == "__main__":
    unittest.main()
