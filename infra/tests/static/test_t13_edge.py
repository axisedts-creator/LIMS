"""T-13 tests (tester role): nginx public edge - origins, TLS, ACME, headers, generated path allowlist, rate-limit zones,
payment locations, access-log format (02-TRD s6.1-6.7, 6.9; 06-PLAN row T-13).

ACs: AC-02.1/.2/.4, AC-03.1-3.3, AC-04.1/.1a/.2/.3/.3a/.8/.9/.10, AC-06.1, AC-18.4, AC-26.1. LD-45: no host name in a template;
both profiles render. AC-02.3 (`TLSCertExpiringSoon`/`TLSCertExpiryCritical` rules) lives in the alert-rule files (T-19/T-21), not here.

HOW: there is no nginx binary on the test host, so this module (a) parses the committed nginx text with a small nginx parser,
(b) resolves locations with nginx's own precedence (= / ^~ longest prefix / first regex / longest prefix), (c) replays the
`limit_req` leaky bucket (ngx_http_limit_req_module arithmetic) over the AC scenarios using the rates/bursts the config
declares, (d) runs gen-routes.sh against synthetic OpenAPI fixtures. Real `nginx -t` + real sockets: infra/tests/integration/
test_t13_live.py (LIMS_T13_LIVE=1). The parser/limiter are proven against the TRD's own text in HelperSelfTest.

CONTRACTS where the spec is silent (writer meets them or files a dispute; nothing here is a silent design change):
 * infra/edge/nginx/{nginx.conf, snippets/{tls,headers,headers-payments,proxy,limits,errors,logformat}.conf} are plain nginx text;
   sites/{staff_web,portal,partner,api,acme}.conf.j2 are Jinja2. NO files site, NO headers-files.conf.
 * Site render vars (only these): origins.{staff_web,portal,api,partner}, partner_enabled, public_routes (list = `routes:` of
   public-routes.yaml), wg_ip, inventory_hostname, hostvars, groups, docker_subnets. An undefined variable in a render = FAIL.
 * The internal listener (`listen <wg_ip>:8090`, allow = the ops host's wg_ip, deny all) may live in nginx.conf, any site template or
   roles/edge_nginx/templates/*.j2; the test finds the server by its port. Allowed source = hostvars[groups['ops'][0]].wg_ip.
 * public-routes.yaml: `routes:` list of {path, match: exact|prefix, owner, phase, methods, zone, body_limit}; api.conf.j2 renders one
   location per entry (prefix -> `^~ path`, exact -> `= path`), zone burst/Retry-After from a fixed zone table, no hand-added proxy location.
 * infra/ci/gen-routes.sh [--openapi-dir DIR] (default contracts/openapi): YAML on stdout, deterministic, only operations with
   `x-edge-exposure: public`; any other value (typo) = non-zero exit (fail closed). Wave-1 entries (agent, provider-callbacks, payments) are
   not yet marked public in contracts/openapi (C0-owned) - the writer must source them (built-in seed or CR); the drift test compares
   the committed file to the generator's default output and requires the wave-1 prefixes in both.
 * acme role: certbot ecdsa/secp256r1, webroot /var/www/acme, twice-daily timer, deploy hook `nginx -t && nginx -s reload`, a staging-ACME
   and an internal_ca option for dev.
 * infra/tests/external/{tls.sh,headers.py,routes.py,ratelimit.py}: exist, compile/`bash -n`, and exit non-zero when pointed at nothing.
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t13_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
EDGE = ROOT / "infra" / "edge"
NGX = EDGE / "nginx"
SNIP = NGX / "snippets"
SITES = NGX / "sites"
ROUTES_YAML = EDGE / "public-routes.yaml"
GEN = ROOT / "infra" / "ci" / "gen-routes.sh"
ROLES = ROOT / "infra" / "ansible" / "roles"
EDGE_ROLE = ROLES / "edge_nginx"
ACME_ROLE = ROLES / "acme"
SITE_YML = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
EXT = ROOT / "infra" / "tests" / "external"
HOSTNAME_RE = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")

PROFILES = {  # LD-45 (host names/counts come from the active profile)
    "full": {"hosts": {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"},
             "groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]}},
    "lean": {"hosts": {"prod-1": "10.79.0.11", "backup-1": "10.79.0.15"},
             "groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": ["backup-1"]}},
    "dev": {"hosts": {"dev-1": "10.79.0.11"},
            "groups": {"data": ["dev-1"], "app": ["dev-1"], "ops": ["dev-1"], "dr": []}},
}
ORIGINS = {"staff_web": "lab.example.test", "portal": "portal.example.test",
           "api": "api.example.test", "partner": "partner.example.test"}
BFF = ("staff_web", "portal", "partner")
DENY = ["/v1/", "/rest/v1/", "/graphql/v1", "/functions/v1/", "/auth/v1/", "/storage/v1/", "/realtime/v1/", "/pg/",
        "/api/mcp", "/mcp"]
SUPABASE = ["/rest/v1/", "/graphql/v1", "/functions/v1/", "/auth/v1/", "/storage/v1/", "/realtime/v1/", "/pg/", "/api/mcp", "/mcp"]
# TRD s6.5: zone -> (rate in r/s * 1000 'milli', burst, Retry-After override or None). 08 A1/A13/A19, CR-C6-013, CR-C15-008.
ZONES = {"login": ("60r/m", 20, "60"), "otp": ("60r/m", 20, "60"), "psession": ("120r/m", 40, "60"),
         "qrverify": ("10r/m", 9, "60"), "agent": ("600r/m", 200, "60"), "callback": ("60r/m", 20, "60"),
         "payments": ("10r/s", 20, None)}
SEC_HEADERS = {
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}
CIPHERS12 = ["ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES128-GCM-SHA256", "ECDHE-ECDSA-AES256-GCM-SHA384",
             "ECDHE-RSA-AES256-GCM-SHA384", "ECDHE-ECDSA-CHACHA20-POLY1305", "ECDHE-RSA-CHACHA20-POLY1305"]
SUITES13 = ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256"]


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


ENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def uncommented(text):
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("#"))


def load_routes():
    doc = yaml.safe_load(need(ROUTES_YAML))
    if not isinstance(doc, dict) or not isinstance(doc.get("routes"), list):
        raise AssertionError("public-routes.yaml needs a top-level `routes:` list")
    return doc["routes"]


# ----------------------------------------------------------------------------------------------- mini nginx
class Node:
    def __init__(self, name, args, children=None):
        self.name, self.args, self.children = name, args, children

    def kids(self, name):
        return [c for c in (self.children or []) if c.name == name]

    def __repr__(self):
        return "<%s %s>" % (self.name, " ".join(self.args))


_TOK = re.compile(r"""\s*(?:#[^\n]*|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([{};])|([^\s{};'"#]+))""")


def tokenize(text):
    pos, out = 0, []
    while pos < len(text):
        m = _TOK.match(text, pos)
        if not m:
            if not text[pos:].strip():
                break
            raise AssertionError("nginx tokenizer stuck at %r" % text[pos:pos + 40])
        pos = m.end()
        if m.group(1) is not None:
            out.append(("s", m.group(1)[1:-1]))
        elif m.group(2):
            out.append(("p", m.group(2)))
        elif m.group(3):
            out.append(("w", m.group(3)))
    return out


def parse(text):
    root = Node("root", [], [])
    stack, cur = [root], []
    for kind, val in tokenize(text):
        if kind == "p" and val == ";":
            if not cur:
                raise AssertionError("stray ';'")
            stack[-1].children.append(Node(cur[0], cur[1:]))
            cur = []
        elif kind == "p" and val == "{":
            blk = Node(cur[0], cur[1:], [])
            stack[-1].children.append(blk)
            stack.append(blk)
            cur = []
        elif kind == "p" and val == "}":
            if len(stack) < 2:
                raise AssertionError("unbalanced '}'")
            stack.pop()
        else:
            cur.append(val)
    if len(stack) != 1 or cur:
        raise AssertionError("unterminated nginx block/directive")
    return root


def expand(node):
    """Splice `include snippets/x.conf;` (relative to infra/edge/nginx) in place; missing target = FAIL; globs are left alone."""
    if node.children is None:
        return node
    out = []
    for c in node.children:
        if c.name == "include" and c.args and "*" not in c.args[0]:
            rel = c.args[0].replace("/etc/nginx/", "")
            sub = expand(parse(need(NGX / rel)))
            out.extend(sub.children)
        else:
            out.append(expand(c))
    node.children = out
    return node


def parse_conf(text):
    return expand(parse(text))


def walk(node):
    yield node
    for c in node.children or []:
        yield from walk(c)


def loc_parts(loc):
    if len(loc.args) == 1:
        return "", loc.args[0]
    return loc.args[0], loc.args[1]


def zone_limits(loc):
    """T-13 ruling: a location's own limit_req replaces the server-level one in nginx, so it must repeat the
    02-TRD.md:382 perip safety net exactly; returns the remaining (zone-specific) limit_req arg lists."""
    lr = [x.args for x in loc.kids("limit_req")]
    if lr:
        assert ["zone=perip", "burst=200", "nodelay"] in lr, "location limit_req lacks perip safety net: %s" % lr
    return [a for a in lr if "zone=perip" not in a]


def match_location(server, uri):
    """nginx precedence: exact, longest ^~/plain prefix (^~ stops), first matching regex, else longest prefix."""
    locs = [(loc_parts(l), l) for l in server.kids("location") if not loc_parts(l)[1].startswith("@")]
    for (mod, path), l in locs:
        if mod == "=" and path == uri:
            return l
    pre = [(len(path), l, mod) for (mod, path), l in locs if mod in ("", "^~") and uri.startswith(path)]
    best = max(pre, key=lambda t: t[0], default=None)
    if best and best[2] == "^~":
        return best[1]
    for (mod, path), l in locs:
        if mod in ("~", "~*") and re.search(path, uri, re.I if mod == "~*" else 0):
            return l
    return best[1] if best else None


def eff(server, loc, name):
    """add_header / proxy_set_header / error_page inheritance: location's own set replaces the server's."""
    own = loc.kids(name) if loc is not None else []
    return own or server.kids(name)


def eff_value(server, loc, name, http=None):
    for scope in (loc, server, http):
        if scope is not None and scope.kids(name):
            return scope.kids(name)[-1].args
    return None


def headers_of(server, loc):
    return {d.args[0].lower(): (d.args[1] if len(d.args) > 1 else "", d.args[2:] == ["always"]) for d in eff(server, loc, "add_header")}


def returns(loc):
    return [d.args for d in (loc.kids("return") if loc else [])]


def servers_of(root):
    return [n for n in walk(root) if n.name == "server"]


def listens(server):
    out = []
    for d in server.kids("listen"):
        m = re.search(r"(?:^|:)(\d+)$", d.args[0])
        out.append((int(m.group(1)) if m else 80, d.args[0], d.args[1:]))
    return out


def server_for(root, host, port=443):
    for s in servers_of(root):
        names = [a for d in s.kids("server_name") for a in d.args]
        if host in names and any(p == port for p, _, _ in listens(s)):
            return s
    raise AssertionError("no server {listen %s; server_name %s}" % (port, host))


# limit_req leaky bucket, ngx_http_limit_req_module (millisecond clock, requests*1000 excess units)
def rate_milli(rate):
    m = re.fullmatch(r"(\d+)r/([sm])", rate)
    return int(m.group(1)) * 1000 // (1 if m.group(2) == "s" else 60)


def simulate(rate, burst, times_ms):
    r, excess, last, acc, rej = rate_milli(rate), 0, None, 0, 0
    for t in times_ms:
        if last is None:
            ex = 0
        else:
            ex = max(excess - r * max(t - last, 0) // 1000 + 1000, 0)
        if ex > burst * 1000:
            rej += 1
            continue
        excess, last, acc = ex, t, acc + 1
    return acc, rej


def eval_map(map_node, value):
    """nginx map semantics: exact strings first, then regexes in file order, then default."""
    regexes = []
    default = ""
    for d in map_node.children:
        key, val = d.name, (d.args[0] if d.args else "")
        if key == "default":
            default = val
        elif key.startswith("~"):
            regexes.append((key[1:] if key == "~" else key[1:], val))
        elif key == value:
            return val
    for rx, val in regexes:
        m = re.search(rx, value)
        if m:
            return re.sub(r"\$(\d)", lambda mm: m.group(int(mm.group(1))), val)
    return default


def find_all(text_root, name):
    return [n for n in walk(text_root) if n.name == name]


# ----------------------------------------------------------------------------------------------- rendering
def ctx(profile="full", routes=None, partner_enabled=True, **extra):
    p = PROFILES[profile]
    app = p["groups"]["app"][0]
    c = {"origins": dict(ORIGINS), "partner_enabled": partner_enabled,
         "public_routes": load_routes() if routes is None else routes,
         "wg_ip": p["hosts"][app], "inventory_hostname": app, "groups": p["groups"],
         "hostvars": {h: {"wg_ip": ip} for h, ip in p["hosts"].items()},
         "docker_subnets": {"edge": "172.30.10.0/24", "app": "172.30.20.0/24"}}
    c.update(extra)
    return c


def render(path, **kw):
    out = ENV.from_string(need(path)).render(**ctx(**kw))
    if "UNDEF_" in out:
        raise AssertionError("%s renders an undefined variable: %s" % (Path(path).name, re.findall(r"UNDEF_\w+", out)[:3]))
    return out


def site(name, **kw):
    return parse_conf(render(SITES / ("%s.conf.j2" % name), **kw))


def https_server(name, **kw):
    return server_for(site(name, **kw), ORIGINS[name])


def nginx_conf():
    return parse_conf(need(NGX / "nginx.conf"))


def snippet(name):
    return parse_conf(need(SNIP / name))


def sample(path):
    return re.sub(r"\{[^}]*\}", "x", path)


def route_uri(r):
    p = sample(r["path"])
    return p if r.get("match") == "exact" or not p.endswith("/") else p + "x"


def api_proxy_locations(server):
    return [l for l in server.kids("location") if l.kids("proxy_pass")]


# =============================================================================================== helper proof (passes now)
TRD_LIMITS = r'''
map "$request_method:$uri" $login_key { ~^POST: $binary_remote_addr; "GET:/auth/confirm" $binary_remote_addr; default ""; }
limit_req_zone $login_key          zone=login:10m    rate=60r/m;
limit_req_zone $binary_remote_addr zone=qrverify:10m rate=10r/m;
limit_req_zone $binary_remote_addr zone=agent:10m    rate=600r/m;
limit_req_zone $binary_remote_addr zone=payments:10m rate=10r/s;
limit_req_status 429;
location @r { default_type application/problem+json; add_header Retry-After $retry_after always; return 429 '{"type":"urn:x","code":"common.rate_limited"}'; }
'''


class HelperSelfTest(unittest.TestCase):
    """The parser/limiter are the instrument: prove them on the TRD's own text before trusting any verdict."""

    def test_parser_handles_quoted_braces_and_maps(self):
        root = parse(TRD_LIMITS)
        mp = find_all(root, "map")[0]
        self.assertEqual(eval_map(mp, "POST:/auth/login"), "$binary_remote_addr")
        self.assertEqual(eval_map(mp, "GET:/auth/login"), "")
        self.assertEqual(eval_map(mp, "GET:/auth/confirm"), "$binary_remote_addr")
        body = find_all(root, "return")[0].args[1]
        self.assertEqual(json.loads(body)["code"], "common.rate_limited")

    def test_limiter_reproduces_the_prd_numbers(self):
        self.assertEqual(simulate("60r/m", 20, [0] * 41), (21, 20))  # AC-04.1
        self.assertEqual(simulate("60r/m", 20, [i * 1000 for i in range(60)]), (60, 0))
        self.assertEqual(simulate("10r/m", 9, [0] * 11), (10, 1))  # AC-04.2
        self.assertEqual(simulate("600r/m", 200, [0] * 401), (201, 200))  # AC-04.3
        self.assertEqual(simulate("600r/m", 200, [i * 100 for i in range(600)]), (600, 0))
        self.assertEqual(simulate("10r/s", 20, [0] * 41), (21, 20))  # AC-04.8

    def test_location_precedence(self):
        s = parse("server { location / {return 404;} location ^~ /a/ {return 1;} location ~ ^/a/(b|x)$ {return 2;} "
                  "location = /a/c {return 3;} location /a/b {return 4;} }").children[0]
        self.assertEqual(returns(match_location(s, "/a/b"))[0], ["2"])  # longest prefix `/a/b` is plain -> regex wins
        self.assertEqual(returns(match_location(s, "/a/x"))[0], ["1"])  # longest prefix `^~ /a/` stops the regex search
        self.assertEqual(returns(match_location(s, "/a/c"))[0], ["3"])
        self.assertEqual(returns(match_location(s, "/zzz"))[0], ["404"])


# =============================================================================================== layout, origins, no files origin
class LayoutTest(unittest.TestCase):
    def test_files_exist(self):  # TRD s2 tree
        for rel in ("nginx.conf", "snippets/tls.conf", "snippets/headers.conf", "snippets/headers-payments.conf", "snippets/proxy.conf",
                    "snippets/limits.conf", "snippets/errors.conf", "snippets/logformat.conf", "sites/staff_web.conf.j2",
                    "sites/portal.conf.j2", "sites/partner.conf.j2", "sites/api.conf.j2", "sites/acme.conf.j2"):
            need(NGX / rel)
        need(ROUTES_YAML)

    def test_no_files_origin_anywhere(self):  # AC-03.2, 08 A14.2
        self.assertFalse((SITES / "files.conf.j2").exists())
        self.assertFalse((SNIP / "headers-files.conf").exists())
        for base in (NGX, EDGE_ROLE, ACME_ROLE, ROUTES_YAML):
            files = [base] if base.is_file() else [p for p in base.rglob("*") if p.is_file()] if base.exists() else []
            for p in files:
                t = p.read_text(encoding="utf-8", errors="replace")
                self.assertNotRegex(t, r"LIMS_ORIGIN_FILES|origins\.files|files_origin", p.as_posix())

    def test_nothing_proxies_to_gateway_or_storage(self):  # AC-03.2
        for name in ("staff_web", "portal", "partner", "api"):
            for l in walk(site(name)):
                for pp in l.kids("proxy_pass"):
                    self.assertNotRegex(pp.args[0], r"api-gw|kong|storage|imgproxy|:8000|:5000|studio|meta", name)

    def test_no_host_names_or_ips_in_templates(self):  # LD-45
        for p in list(NGX.rglob("*")) + list(EDGE_ROLE.rglob("*")) + list(ACME_ROLE.rglob("*")):
            if p.is_file():
                t = uncommented(p.read_text(encoding="utf-8", errors="replace"))
                self.assertIsNone(HOSTNAME_RE.search(t), "%s hard-codes a host name" % p.name)
                if p.suffix == ".j2" or p.name.endswith(".conf"):
                    self.assertNotRegex(re.sub(r"172\.30\.\d+\.\d+|127\.0\.0\.1|0\.0\.0\.0", "", t), r"\b\d{1,3}(\.\d{1,3}){3}\b", p.name)

    def test_every_profile_renders_all_sites(self):  # LD-45: both profiles pass
        for prof in PROFILES:
            for name in ("staff_web", "portal", "partner", "api", "acme"):
                site(name, profile=prof)


# =============================================================================================== TLS, ACME, port 80
class TlsTest(unittest.TestCase):
    def setUp(self):
        self.d = {n.name: n.args for n in snippet("tls.conf").children}

    def test_protocols_only_12_13(self):  # AC-02.1
        self.assertEqual(sorted(self.d["ssl_protocols"]), ["TLSv1.2", "TLSv1.3"])

    def test_exactly_the_six_tls12_suites(self):  # AC-02.1 (04 I5)
        self.assertEqual(self.d["ssl_ciphers"][0].split(":"), CIPHERS12)

    def test_exactly_the_three_tls13_suites(self):
        cc = [d.args for d in snippet("tls.conf").kids("ssl_conf_command")]
        self.assertIn(["Ciphersuites", ":".join(SUITES13)], cc)

    def test_curves_session_settings(self):
        curves = self.d["ssl_ecdh_curve"][0].split(":")
        self.assertEqual([c for c in curves if c != "X25519MLKEM768"], ["X25519", "prime256v1", "secp384r1"])
        self.assertEqual(self.d["ssl_prefer_server_ciphers"], ["off"])
        self.assertEqual(self.d["ssl_session_tickets"], ["off"])
        self.assertEqual(self.d["ssl_session_timeout"], ["1d"])
        self.assertEqual(self.d["ssl_session_cache"], ["shared:TLS:20m"])

    def test_each_https_server_has_own_cert_and_http2_no_http3(self):  # AC-02.2 is runtime (ECDSA P-256); here: distinct paths
        paths = []
        for name in ("staff_web", "portal", "partner", "api"):
            s = https_server(name)
            crt = s.kids("ssl_certificate")[0].args[0]
            key = s.kids("ssl_certificate_key")[0].args[0]
            self.assertRegex(crt, r"^/etc/nginx/certs/.+/fullchain\.pem$")
            self.assertRegex(key, r"^/etc/nginx/certs/.+/privkey\.pem$")
            paths.append(crt)
            ls = [x for p, a, f in listens(s) for x in [a] + f if p == 443]
            self.assertTrue(any("ssl" in f for p, a, f in listens(s)), name)
            self.assertTrue("http2" in " ".join(ls) or s.kids("http2") and s.kids("http2")[0].args == ["on"], "HTTP/2 on 443")
            self.assertNotRegex(" ".join(ls), r"quic|http3|reuseport.*quic")
            self.assertFalse(s.kids("http3") and s.kids("http3")[0].args == ["on"])
            # tls.conf must be in effect (include or via http level)
            has = {n.name for n in s.children} | {n.name for n in nginx_conf().kids("http")[0].children if n.name.startswith("ssl_")}
            self.assertIn("ssl_protocols", has, name)
        self.assertEqual(len(set(paths)), 4, "one certificate per origin")


class AcmeAndPort80Test(unittest.TestCase):
    def srv(self, **kw):
        ss = [s for s in servers_of(site("acme", **kw)) if any(p == 80 for p, _, _ in listens(s))]
        self.assertTrue(ss, "acme.conf.j2 has no :80 server")
        return ss[0]

    def test_challenge_served_from_webroot(self):  # TRD s6.2
        s = self.srv()
        l = match_location(s, "/.well-known/acme-challenge/abc")
        self.assertEqual(loc_parts(l), ("^~", "/.well-known/acme-challenge/"))
        self.assertEqual(l.kids("root")[0].args, ["/var/www/acme"])

    def test_everything_else_is_301_to_https(self):  # AC-02.4
        s = self.srv()
        for uri in ("/", "/auth/login", "/v1/instruments/agent/config", "/.well-known/other", "/.well-known/acme-challenge"):
            l = match_location(s, uri)
            r = returns(l)
            self.assertTrue(r and r[0][0] == "301" and re.match(r"https://\$host\$request_uri$", r[0][1]), "%s -> %s" % (uri, r))
            self.assertFalse(l.kids("proxy_pass"))

    def test_port80_covers_every_origin_and_is_default(self):
        s = self.srv()
        names = [a for d in s.kids("server_name") for a in d.args]
        ok = set(ORIGINS.values()) <= set(names) or "_" in names or any("default_server" in f for _, _, f in listens(s))
        self.assertTrue(ok)

    def test_no_app_traffic_on_port80(self):
        for s in servers_of(site("acme")):
            if any(p == 80 for p, _, _ in listens(s)):
                self.assertFalse([n for n in walk(s) if n.name == "proxy_pass"])


# =============================================================================================== headers
class HeadersTest(unittest.TestCase):
    def test_headers_conf_values_and_always(self):  # AC-03.1
        h = headers_of(Node("s", [], []), snippet("headers.conf"))
        self.assertEqual({k.lower() for k in SEC_HEADERS} - set(h), set())
        for k, v in SEC_HEADERS.items():
            self.assertEqual(h[k.lower()], (v, True), k)
        self.assertNotIn("preload", h["strict-transport-security"][0])  # 04 I6

    def test_server_tokens_off_and_powered_by_hidden(self):  # AC-03.3
        txt = uncommented(need(NGX / "nginx.conf") + need(SNIP / "headers.conf"))
        self.assertRegex(txt, r"server_tokens\s+off\s*;")
        self.assertNotRegex(txt, r"server_tokens\s+(on|build)")
        self.assertRegex(txt, r"proxy_hide_header\s+X-Powered-By\s*;")

    def test_payments_headers(self):  # TRD s6.4 / AC-04.8
        h = headers_of(Node("s", [], []), snippet("headers-payments.conf"))
        self.assertEqual(h["referrer-policy"], ("no-referrer", True))
        self.assertEqual(h["cache-control"], ("no-store", True))
        for k, v in SEC_HEADERS.items():
            if k != "Referrer-Policy":
                self.assertEqual(h[k.lower()], (v, True), k)

    def test_every_https_location_carries_the_security_headers(self):  # AC-03.1 'any HTTPS response' incl. nginx-made 404s
        for name in ("staff_web", "portal", "partner", "api"):
            s = https_server(name)
            for l in [None] + s.kids("location"):
                if l is not None and loc_parts(l)[1].startswith("@"):
                    continue
                h = headers_of(s, l)
                for k, v in SEC_HEADERS.items():
                    if k == "Referrer-Policy" and h.get(k.lower(), ("",))[0] == "no-referrer":
                        continue
                    self.assertEqual(h.get(k.lower()), (v, True), "%s %s missing %s" % (name, l, k))

    def test_429_response_carries_the_security_headers_too(self):  # AC-03.1: add_header in the named location replaces the inherited set
        for name in ("staff_web", "portal", "api"):
            s = https_server(name)
            named = [l for l in s.kids("location") if loc_parts(l)[1].startswith("@")]
            self.assertTrue(named, "%s: no @ratelimited location" % name)
            h = headers_of(s, named[0])
            self.assertIn("retry-after", h)
            self.assertEqual(h.get("strict-transport-security"), (SEC_HEADERS["Strict-Transport-Security"], True), name)
            self.assertEqual(h.get("x-content-type-options"), ("nosniff", True), name)


# =============================================================================================== path allowlist / default deny
class BffOriginsTest(unittest.TestCase):
    UPSTREAM = {"staff_web": r"^http://web:3000", "portal": r"^http://portal:3000", "partner": r"^http://partner:3000"}

    def test_reserved_prefixes_are_404_never_proxied(self):  # AC-06.1, AC-03.2
        for name in BFF:
            s = https_server(name)
            for p in DENY:
                for uri in (p, p + "x" if p.endswith("/") else p + "/x"):
                    l = match_location(s, uri)
                    self.assertIsNotNone(l, (name, uri))
                    self.assertEqual(returns(l), [["404"]], "%s %s must return 404" % (name, uri))
                    self.assertFalse(l.kids("proxy_pass"), "%s %s proxied" % (name, uri))

    def test_app_paths_are_served(self):
        for name, rx in self.UPSTREAM.items():
            s = https_server(name)
            for uri in ("/", "/dashboard", "/auth/login", "/auth/mfa/enrol", "/r/abc", "/v/abc") if name != "staff_web" else ("/", "/dashboard", "/auth/login", "/auth/confirm"):
                l = match_location(s, uri)
                self.assertRegex(l.kids("proxy_pass")[0].args[0], rx, "%s %s" % (name, uri))

    def test_staff_web_login_routes_use_the_login_zone(self):  # AC-04.1
        s = https_server("staff_web")
        for uri in ("/auth/login", "/auth/mfa", "/auth/mfa/enrol", "/auth/forgot", "/auth/confirm", "/auth/set-password"):
            self.assertEqual(zone_limits(match_location(s, uri)), [["zone=login", "burst=20", "nodelay"]], uri)
            self.assertEqual([d.args for d in match_location(s, uri).kids("set") if d.args[0] == "$retry_after"], [["$retry_after", "60"]])
        self.assertFalse([d for d in match_location(s, "/auth/v1/user").kids("limit_req")])

    def test_portal_qr_zone_only_on_v(self):  # AC-04.2
        s = https_server("portal")
        self.assertEqual(zone_limits(match_location(s, "/v/abc")), [["zone=qrverify", "burst=9", "nodelay"]])
        for uri in ("/", "/r/abc", "/status/", "/verify"):
            self.assertNotIn("qrverify", " ".join(" ".join(x.args) for x in match_location(s, uri).kids("limit_req")))
        self.assertIsNone(re.search("qrverify", render(SITES / "api.conf.j2")), "api origin must have no QR zone (08 A13 D-32)")
        self.assertIsNone(re.search("qrverify", render(SITES / "staff_web.conf.j2")))

    def test_body_limits(self):  # TRD s6.6
        http = nginx_conf().kids("http")[0]
        want = {"staff_web": "16m", "portal": "1m", "partner": "16m"}
        for name, v in want.items():
            s = https_server(name)
            self.assertEqual(eff_value(s, match_location(s, "/dashboard"), "client_max_body_size", http), [v], name)

    def test_staff_web_sse_timeout_and_proxy_headers(self):  # TRD s6.6
        s = https_server("staff_web")
        l = match_location(s, "/dashboard")
        self.assertEqual(eff_value(s, l, "proxy_read_timeout", nginx_conf().kids("http")[0]), ["300s"])


class ProxyHeadersTest(unittest.TestCase):
    def eff_psh(self, name, uri="/"):
        s = https_server(name)
        l = match_location(s, uri)
        if not l.kids("proxy_pass"):
            l = [x for x in s.kids("location") if x.kids("proxy_pass")][0]
        return {d.args[0].lower(): d.args[1:] for d in eff(s, l, "proxy_set_header")}

    def test_forwarding_headers_overwritten(self):  # REQ-SEC-091, AB-17
        for name in ("staff_web", "portal", "partner", "api"):
            h = self.eff_psh(name)
            self.assertEqual(h["x-forwarded-for"], ["$remote_addr"], name)  # overwrite, never $proxy_add_x_forwarded_for
            self.assertEqual(h["x-forwarded-proto"], ["https"], name)
            self.assertEqual(h["host"], ["$host"], name)
            self.assertEqual(h["x-edge-request-id"], ["$request_id"], name)
            self.assertEqual(h["x-request-id"], [""], name)
            self.assertEqual(h["x-forwarded-host"], [""], name)

    def test_internal_headers_stripped_background_exception(self):  # 08 A25 D-206
        for name in ("staff_web", "portal", "partner", "api"):
            h = self.eff_psh(name)
            self.assertEqual(h.get("x-lims-bff-key"), [""], "%s must never accept X-Lims-Bff-Key from the internet" % name)
        for name in BFF:
            self.assertNotIn("x-lims-background", self.eff_psh(name), "BFF origins pass X-Lims-Background through")
        self.assertEqual(self.eff_psh("api").get("x-lims-background"), [""], "api origin strips it like every X-Lims-*")

    def test_timeouts_and_version_banner(self):  # TRD s6.6, AC-03.3
        t = uncommented(need(NGX / "nginx.conf") + need(SNIP / "proxy.conf"))
        for d, v in (("client_header_timeout", "15s"), ("client_body_timeout", "15s"), ("send_timeout", "30s"), ("keepalive_timeout", "30s"),
                     ("proxy_connect_timeout", "5s"), ("proxy_read_timeout", "60s")):
            self.assertRegex(t, r"%s\s+%s\s*;" % (d, v))


class ApiOriginTest(unittest.TestCase):
    ROUTES_REQUIRED = {  # path -> (zone, body_limit); TRD s6.3 wave 1
        "/v1/instruments/agent/": ("agent", "4m"), "/v1/instruments/agent/attachments": ("agent", "16m"),
        "/v1/reporting/provider-callbacks/": ("callback", "256k"), "/v1/payments/result": ("payments", None),
        "/v1/payments/launch/": ("payments", None), "/v1/payments/callbacks/": ("payments", None)}
    PROBES = ["/", "/pg/", "/api/mcp", "/mcp", "/rest/v1/", "/graphql/v1", "/functions/v1/", "/auth/v1/user", "/storage/v1/object/x",
              "/realtime/v1/", "/v1/core/health/live", "/v1/core/health/ready", "/v1/platform/tenants", "/v1/identity/auth/login",
              "/v1/identity/auth/mfa/verify", "/v1/identity/auth/session/resolve", "/v1/identity/users", "/v1/unknown", "/v1/payments/",
              "/v1/instruments/agents", "/v1/reporting/verifications", "/robots.txt"]

    def setUp(self):
        self.routes = load_routes()
        self.s = https_server("api")

    def allowed(self, uri):
        for r in self.routes:
            p = sample(r["path"])
            if (r.get("match") == "exact" and uri == p) or (r.get("match") != "exact" and uri.startswith(p)):
                return True
        return False

    def test_default_deny(self):  # AC-06.1
        for uri in self.PROBES:
            if self.allowed(uri):
                continue
            l = match_location(self.s, uri)
            self.assertEqual(returns(l), [["404"]], "%s must be 404 at the edge" % uri)
            self.assertFalse(l.kids("proxy_pass"))

    def test_storage_is_404_on_every_public_host(self):  # AC-03.2
        for name in ("staff_web", "portal", "partner", "api"):
            s = https_server(name)
            for uri in ("/storage/v1/object/public/x", "/storage/v1/", "/storage/v1/object/sign/x?token=1"):
                self.assertEqual(returns(match_location(s, uri.split("?")[0])), [["404"]], (name, uri))

    def test_bff_only_identity_paths_are_404_except_listed_exemptions(self):  # AC-04.1a, AC-26.1
        exempt = {sample(r["path"]) for r in self.routes if sample(r["path"]).startswith("/v1/identity/auth/")}
        self.assertLessEqual(exempt, {"/v1/identity/auth/patient/session/resolve", "/v1/identity/auth/patient/session/logout"})
        for uri in ("/v1/identity/auth/login", "/v1/identity/auth/mfa/challenges", "/v1/identity/auth/session/resolve",
                    "/v1/identity/auth/partner/login", "/v1/identity/auth/patient/session", "/v1/identity/auth/patient/session/resolvex"):
            if uri in exempt:
                continue
            l = match_location(self.s, uri)
            self.assertEqual(returns(l), [["404"]], uri)
        for uri in exempt:
            self.assertTrue(match_location(self.s, uri).kids("proxy_pass"), "%s is in public-routes.yaml but not served" % uri)
        for l in self.s.kids("location"):
            self.assertFalse([d for d in l.kids("limit_req") if "zone=login" in d.args and "/v1/identity/auth/" in loc_parts(l)[1]],
                             "no login zone on BFF-only API routes (08 R6)")

    def test_upstream_pool(self):  # TRD s6.1
        ups = [u for r in (nginx_conf(), site("api")) for u in find_all(r, "upstream") if u.args == ["api"]]
        self.assertEqual(len(ups), 1, "exactly one `upstream api`")
        self.assertEqual(sorted(tuple(d.args) for d in ups[0].kids("server")),
                         [("api-a:8080", "max_fails=3", "fail_timeout=10s"), ("api-b:8080", "max_fails=3", "fail_timeout=10s")])
        for l in api_proxy_locations(self.s):
            self.assertRegex(l.kids("proxy_pass")[0].args[0], r"^http://api(/|$)")

    def test_api_default_body_limit_1m(self):
        http = nginx_conf().kids("http")[0]
        self.assertEqual(eff_value(self.s, self.s, "client_max_body_size", http), ["1m"])

    def test_every_yaml_route_is_served_with_its_zone_and_limit_and_nothing_else(self):  # TRD s6.3: no hand-added proxy location
        served = set()
        for r in self.routes:
            l = match_location(self.s, route_uri(r))
            self.assertTrue(l is not None and l.kids("proxy_pass"), "route %s not served" % r["path"])
            mod, path = loc_parts(l)
            self.assertEqual(path, sample(r["path"]), r["path"])
            self.assertEqual(mod, "=" if r.get("match") == "exact" else "^~", r["path"])
            served.add((mod, path))
            if r.get("zone") not in (None, "", "none"):
                self.assertIn("zone=" + r["zone"], [a for d in l.kids("limit_req") for a in d.args], r["path"])
            if r.get("body_limit"):
                self.assertEqual(l.kids("client_max_body_size")[-1].args, [r["body_limit"]], r["path"])
        actual = {loc_parts(l) for l in api_proxy_locations(self.s)}
        self.assertEqual(actual, served, "proxy locations on the api origin must equal public-routes.yaml")

    def test_wave1_entries_in_committed_yaml(self):  # TRD s6.3 / 06-PLAN T-13
        by = {r["path"]: r for r in self.routes}
        for path, (zone, body) in self.ROUTES_REQUIRED.items():
            self.assertIn(path, by)
            self.assertEqual(by[path]["zone"], zone, path)
            if body:
                self.assertEqual(by[path]["body_limit"], body, path)
        for path in ("/v1/payments/result", "/v1/payments/launch/", "/v1/payments/callbacks/"):
            self.assertLessEqual(set(by[path]["methods"]), {"GET", "HEAD"}, path)
        self.assertEqual(by["/v1/payments/result"]["match"], "exact")

    def test_yaml_entries_complete_and_unique(self):
        seen = set()
        for r in self.routes:
            for k in ("path", "match", "owner", "phase", "methods", "zone", "body_limit"):
                self.assertIn(k, r, r)
            self.assertIn(r["match"], ("exact", "prefix"))
            self.assertTrue(r["path"].startswith("/v1/"), r["path"])
            self.assertNotIn((r["match"], r["path"]), seen)
            seen.add((r["match"], r["path"]))
            self.assertFalse(any(sample(r["path"]).startswith(p) for p in SUPABASE + ["/v1/platform/", "/v1/core/"]), r["path"])

    def test_zone_table_applied_to_any_route(self):  # AC-04.1/.9/.10, AC-04.3: burst + Retry-After per zone, nodelay always
        for zone, (_, burst, retry) in ZONES.items():
            if zone == "qrverify":
                continue
            rt = [{"path": "/v1/zz/%s/" % zone, "match": "prefix", "owner": "T", "phase": 1, "methods": ["GET", "POST"], "zone": zone, "body_limit": None}]
            s = https_server("api", routes=rt)
            l = match_location(s, "/v1/zz/%s/x" % zone)
            self.assertEqual(zone_limits(l), [["zone=" + zone, "burst=%d" % burst, "nodelay"]], zone)
            ra = [d.args for d in l.kids("set") if d.args[0] == "$retry_after"]
            self.assertEqual(ra, [["$retry_after", retry]] if retry else [], zone)

    def test_server_level_retry_after_default_and_perip(self):  # TRD s6.5 429 handling + 'every server'
        for name in ("staff_web", "portal", "api"):
            s = https_server(name)
            self.assertIn(["$retry_after", "1"], [d.args for d in s.kids("set")], name)
            self.assertIn(["zone=perip", "burst=200", "nodelay"], [d.args for d in s.kids("limit_req")], name)
            self.assertIn(["connip", "200"], [d.args for d in s.kids("limit_conn")], name)
            self.assertEqual(s.kids("error_page")[0].args[:3], ["429", "=", "@ratelimited"], name)


# =============================================================================================== payments (CR-C15-008)
class PaymentsLocationsTest(unittest.TestCase):
    def setUp(self):
        self.s = https_server("api")
        self.locs = {u: match_location(self.s, u) for u in (
            "/v1/payments/result", "/v1/payments/launch/tok", "/v1/payments/callbacks/esewa/tok/success", "/v1/payments/callbacks/khalti/tok")}

    def ifs(self, l):
        """{condition: [return args]} - `if ($a ~ "x")` tokenises as '($a','~','x',')': rebuild and strip the parentheses."""
        out = {}
        for d in l.kids("if"):
            c = " ".join(d.args).strip()
            c = c[1:] if c.startswith("(") else c
            c = c.rstrip()[:-1] if c.rstrip().endswith(")") else c
            out[" ".join(c.split())] = [r.args for r in d.kids("return")]
        return out

    def test_methods_get_head_only(self):  # AC-04.8
        for u, l in self.locs.items():
            m = {k: v for k, v in self.ifs(l).items() if "$request_method" in k}
            self.assertEqual(list(m.values()), [[["405"]]], u)
            cond = list(m)[0]
            rx = re.search(r"!~\s+(\S+)$", cond).group(1).strip("\"'")
            for ok in ("GET", "HEAD"):
                self.assertRegex(ok, rx)
            for bad in ("POST", "PUT", "DELETE", "PATCH", "OPTIONS"):
                self.assertNotRegex(bad, rx)

    def test_body_refused_with_413_and_zero_not_used(self):  # AC-04.8
        for u, l in self.locs.items():
            ifs = self.ifs(l)
            cl = [k for k in ifs if "$http_content_length" in k]
            te = [k for k in ifs if "$http_transfer_encoding" in k]
            self.assertTrue(cl and te, u)
            self.assertEqual(ifs[cl[0]], [["413"]])
            self.assertEqual(ifs[te[0]], [["413"]])
            rx = re.search(r"~\s+(\S+)$", cl[0]).group(1).strip("\"'")
            for body in ("1", "17", "00012", "999999"):
                self.assertRegex(body, rx)
            for none in ("0", "000", ""):
                self.assertNotRegex(none, rx)
            self.assertFalse([d for d in l.kids("client_max_body_size") if d.args[0] in ("0", "0k", "0m")], "client_max_body_size 0 means unlimited")

    def test_payments_zone_and_headers(self):  # AC-04.8
        for u, l in self.locs.items():
            self.assertEqual(zone_limits(l), [["zone=payments", "burst=20", "nodelay"]], u)
            self.assertEqual([d.args for d in l.kids("set") if d.args[0] == "$retry_after"], [])  # default 1 from the server
            h = headers_of(self.s, l)
            self.assertEqual(h["referrer-policy"], ("no-referrer", True), u)
            self.assertEqual(h["cache-control"], ("no-store", True), u)
            self.assertEqual(h["strict-transport-security"], (SEC_HEADERS["Strict-Transport-Security"], True), u)

    def test_forty_one_gets_give_21_pass_20_429(self):  # AC-04.8
        self.assertEqual(simulate(ZONES["payments"][0], 20, [0] * 41), (21, 20))
        self.assertIn("payments", {a.split(":")[0][5:] for z in find_all(snippet("limits.conf"), "limit_req_zone") for a in z.args if a.startswith("zone=")})


# =============================================================================================== limits.conf, errors.conf
class LimitsTest(unittest.TestCase):
    def setUp(self):
        self.root = snippet("limits.conf")
        self.zones = {}
        for z in find_all(self.root, "limit_req_zone"):
            kv = {a.split("=")[0]: a.split("=")[1] for a in z.args[1:] if "=" in a}
            name, size = kv["zone"].split(":")
            self.zones[name] = (z.args[0], size, kv["rate"])

    def test_zone_table(self):  # TRD s6.5
        want = {"login": ("$login_key", "10m", "60r/m"), "otp": ("$binary_remote_addr", "10m", "60r/m"),
                "psession": ("$binary_remote_addr", "10m", "120r/m"), "qrverify": ("$binary_remote_addr", "10m", "10r/m"),
                "agent": ("$binary_remote_addr", "10m", "600r/m"), "callback": ("$binary_remote_addr", "10m", "60r/m"),
                "payments": ("$binary_remote_addr", "10m", "10r/s"), "perip": ("$binary_remote_addr", "20m", "100r/s")}
        self.assertEqual(self.zones, want)

    def test_every_zone_is_ip_keyed_never_token_keyed(self):  # 08 A13 D-43
        for z in self.zones.values():
            self.assertIn(z[0], ("$binary_remote_addr", "$login_key"))
        t = uncommented(need(SNIP / "limits.conf"))
        self.assertNotRegex(t, r"\$http_authorization|\$http_x_|\$arg_|\$cookie_")

    def test_status_429(self):
        t = uncommented(need(SNIP / "limits.conf"))
        self.assertRegex(t, r"limit_req_status\s+429\s*;")
        self.assertRegex(t, r"limit_conn_status\s+429\s*;")
        self.assertRegex(t, r"limit_conn_zone\s+\$binary_remote_addr\s+zone=connip:10m\s*;")

    def test_login_key_counts_posts_and_confirm_only(self):  # AC-04.1 'only POSTs are counted'
        mp = find_all(self.root, "map")[0]
        for v, want in (("POST:/auth/login", "$binary_remote_addr"), ("POST:/auth/mfa", "$binary_remote_addr"),
                        ("GET:/auth/confirm", "$binary_remote_addr"), ("GET:/auth/login", ""), ("HEAD:/auth/login", ""),
                        ("GET:/auth/mfa/enrol", ""), ("OPTIONS:/auth/login", "")):
            self.assertEqual(eval_map(mp, v), want, v)

    def test_get_page_loads_never_rejected_by_login_zone(self):  # AC-04.1: 100 GET /auth/login at once -> 0 rejected (empty key = not accounted)
        mp = find_all(self.root, "map")[0]
        counted = [t for t in [0] * 100 if eval_map(mp, "GET:/auth/login")]
        self.assertEqual(counted, [])

    def test_every_limited_location_keeps_the_perip_safety_net(self):  # TRD s6.5 "every server"; T-13 review item 1
        # a location-level limit_req replaces the server-level one (nginx inheritance), so each must also carry zone=perip
        for name in ORIGINS:
            srv = https_server(name)
            for loc in [n for n in walk(srv) if n.name == "location"]:
                zs = [a.split("=", 1)[1] for d in loc.kids("limit_req") for a in d.args if a.startswith("zone=")]
                if zs:
                    self.assertIn("perip", zs, "%s location %s sets limit_req %s without zone=perip" % (name, " ".join(loc.args), zs))

    def test_ac_scenarios_from_the_declared_numbers(self):  # AC-04.1/.2/.3/.9/.10
        z = lambda n: self.zones[n][2]
        b = {n: v[1] for n, v in ZONES.items()}
        self.assertEqual(simulate(z("login"), b["login"], [i * 1000 for i in range(60)]), (60, 0))
        self.assertEqual(simulate(z("login"), b["login"], [0] * 41), (21, 20))
        self.assertEqual(simulate(z("qrverify"), b["qrverify"], [0] * 11), (10, 1))
        self.assertEqual(simulate(z("agent"), b["agent"], [i * 100 for i in range(600)]), (600, 0))
        self.assertEqual(simulate(z("agent"), b["agent"], [0] * 401), (201, 200))
        self.assertEqual(simulate(z("callback"), b["callback"], [0] * 41), (21, 20))
        self.assertEqual(simulate(z("otp"), b["otp"], [0] * 41), (21, 20))


class ErrorsTest(unittest.TestCase):
    def test_429_body_is_generic_problem_json_with_retry_after(self):  # TRD s6.5, REQ-SEC-095
        root = snippet("errors.conf")
        self.assertEqual(find_all(root, "error_page")[0].args[:3], ["429", "=", "@ratelimited"])
        named = [l for l in find_all(root, "location") if l.args == ["@ratelimited"]][0]
        self.assertEqual(named.kids("default_type")[0].args, ["application/problem+json"])
        ra = [d.args for d in named.kids("add_header") if d.args[0].lower() == "retry-after"]
        self.assertEqual(ra, [["Retry-After", "$retry_after", "always"]])
        status, body = returns(named)[0]
        self.assertEqual(status, "429")
        doc = json.loads(body)
        self.assertEqual(doc["code"], "common.rate_limited")
        self.assertEqual(doc["status"], 429)
        self.assertNotIn("request_id", doc)  # CV s9.1: the id is generated by BFF/API
        self.assertNotRegex(body, r"\$|nginx|[0-9]+\.[0-9]+\.[0-9]+")  # nothing request-derived or version-like


# =============================================================================================== access log (AC-18.4)
class LogFormatTest(unittest.TestCase):
    FIELDS = ["ts", "edge_request_id", "remote_addr", "host", "method", "route", "status", "bytes", "req_time", "upstream_time",
              "upstream_status", "ua_class", "limit_req_status"]

    def setUp(self):
        self.root = snippet("logformat.conf")

    def fmt(self):
        lf = find_all(self.root, "log_format")
        self.assertEqual(len(lf), 1)
        return lf[0]

    def test_json_fields_present_and_valid(self):
        lf = self.fmt()
        self.assertIn("escape=json", lf.args)
        text = "".join(lf.args[1:]) if "escape=json" not in lf.args else "".join(a for a in lf.args[1:] if a != "escape=json")
        doc = json.loads(re.sub(r"\$\w+", "x", text))
        self.assertEqual(list(doc), self.FIELDS)
        self.assertIn('"$route"', text.replace(" ", ""))

    def test_never_logs_query_string_or_raw_uri(self):  # AC-18.4
        t = uncommented(need(SNIP / "logformat.conf"))
        fmt = "".join(self.fmt().args)
        self.assertNotRegex(fmt, r"\$(args|query_string|request_uri|request|http_referer|http_user_agent|arg_\w+|cookie_\w+|http_authorization)\b")
        self.assertNotRegex(t.split("log_format", 1)[-1].split(";")[0], r"\$args|\$request_uri|\$query_string")

    def test_access_log_uses_json_to_access_json(self):  # TRD s6.7
        txt = uncommented(need(NGX / "nginx.conf") + need(SNIP / "logformat.conf"))
        logs = re.findall(r"access_log\s+([^\s;]+)\s*([^\s;]*)", txt)
        self.assertTrue(logs)
        for path, fmt in logs:
            if path != "off":
                self.assertEqual(path, "/var/log/nginx/access.json")
                self.assertEqual(fmt, self.fmt().args[0])
        self.assertNotIn("access_log off", txt)

    def route_map(self):
        for m in find_all(self.root, "map"):
            if m.args == ["$uri", "$route"]:
                return m
        raise AssertionError("no `map $uri $route`")

    def test_route_templates(self):  # AC-18.4 (IC s7; CR-C2-012, CR-C6-013, CR-C15-008)
        mp = self.route_map()
        tok = "SECRETtoken123"
        cases = {
            "/r/%s" % tok: "/r/{token}", "/v/%s" % tok: "/v/{token}", "/r/payments/%s/done" % tok: "/r/{token}",
            "/v1/reporting/provider-callbacks/%s" % tok: "/v1/reporting/provider-callbacks/{token}",
            "/v1/payments/launch/%s" % tok: "/v1/payments/launch/:token",
            "/v1/payments/callbacks/esewa/%s/success" % tok: "/v1/payments/callbacks/esewa/:token/success",
            "/v1/payments/callbacks/esewa/%s/failure" % tok: "/v1/payments/callbacks/esewa/:token/failure",
            "/v1/payments/callbacks/khalti/%s" % tok: "/v1/payments/callbacks/khalti/:token",
            "/v1/payments/callbacks/unknownpsp/%s" % tok: "/v1/payments/callbacks/{unmatched}",
            "/v1/payments/callbacks/esewa/%s/other" % tok: "/v1/payments/callbacks/{unmatched}",
            "/auth/confirm": "/auth/confirm",
        }
        for uri, want in cases.items():
            got = eval_map(mp, uri)
            self.assertEqual(got, want, uri)
            self.assertNotIn(tok, got, uri)

    def test_route_map_is_keyed_on_uri_not_request_uri(self):
        self.assertEqual(self.route_map().args, ["$uri", "$route"])

    def test_ua_class_is_a_class_not_the_string(self):  # TRD s6.7 [CONV]
        ms = [m for m in find_all(self.root, "map") if m.args and m.args[-1] == "$ua_class"]
        self.assertTrue(ms, "no map ... $ua_class")
        values = {d.args[0] for d in ms[0].children if d.args}
        self.assertLessEqual(values, {"browser", "bridge-agent", "bot", "other"})
        self.assertEqual([d.args[0] for d in ms[0].children if d.name == "default"], ["other"])


# =============================================================================================== internal listener (TRD s6.9)
class InternalListenerTest(unittest.TestCase):
    def sources(self):
        out = [("nginx.conf", need(NGX / "nginx.conf"))]
        out += [(p.name, p.read_text(encoding="utf-8")) for p in sorted(SITES.glob("*.j2"))]
        tdir = EDGE_ROLE / "templates"
        out += [(p.name, p.read_text(encoding="utf-8")) for p in sorted(tdir.glob("*.j2"))] if tdir.is_dir() else []
        return out

    def internal_servers(self, profile):
        found = []
        for n, t in self.sources():
            r = ENV.from_string(t).render(**ctx(profile))
            for s in servers_of(parse(r)):
                if any(p == 8090 for p, _, _ in listens(s)):
                    found.append(s)
        return found

    def test_health_and_stub_status_only_on_wg_ip_from_ops(self):
        for prof, p in PROFILES.items():
            ss = self.internal_servers(prof)
            self.assertEqual(len(ss), 1, "%s: exactly one :8090 server" % prof)
            s = ss[0]
            self.assertEqual([a for pt, a, _ in listens(s)], ["%s:8090" % p["hosts"][p["groups"]["app"][0]]], prof)
            allow = [d.args[0] for d in s.kids("allow")]
            self.assertEqual(allow, [p["hosts"][p["groups"]["ops"][0]]], prof)
            self.assertEqual([d.args for d in s.kids("deny")], [["all"]])
            for uri in ("/v1/core/health/live", "/v1/core/health/ready"):
                self.assertTrue(match_location(s, uri).kids("proxy_pass"), uri)
            self.assertTrue(match_location(s, "/nginx_status").kids("stub_status"))
            for uri in ("/", "/v1/core/health/other", "/v1/identity/users"):
                l = match_location(s, uri)
                self.assertTrue(l is None or returns(l) == [["404"]], uri)


# =============================================================================================== roles + play
class RolesTest(unittest.TestCase):
    def rtext(self, role):
        if not role.is_dir():
            raise AssertionError("missing role %s" % role.relative_to(ROOT).as_posix())
        return {p.relative_to(role).as_posix(): p.read_text(encoding="utf-8") for p in sorted(role.rglob("*")) if p.is_file()}

    def test_edge_role_validates_renders_and_reloads(self):
        f = self.rtext(EDGE_ROLE)
        self.assertIn("tasks/main.yml", f)
        allt = "\n".join(f.values())
        self.assertRegex(allt, r"nginx -t", "config must be validated before reload")
        self.assertRegex(allt, r"partner_enabled")
        self.assertRegex(allt, r"snippets")
        self.assertRegex(allt, r"public-routes\.yaml")  # the allowlist is loaded, not retyped
        self.assertIn("handlers/main.yml", f)
        self.assertRegex(f["handlers/main.yml"], r"nginx -s reload|reload")
        for t in yaml.safe_load_all(f["tasks/main.yml"]):
            self.assertIsInstance(t, list)

    def test_edge_role_keeps_keys_private(self):  # 07-SEC: TLS private keys never leave the host
        allt = "\n".join(self.rtext(EDGE_ROLE).values()) + "\n".join(self.rtext(ACME_ROLE).values())
        self.assertNotRegex(allt, r"ansible\.builtin\.fetch|\bfetch:\s*$|privkey\.pem.*(sops|git)|-----BEGIN")
        self.assertRegex(allt, r"mode:\s*['\"]?0?(600|400|700)")

    def test_acme_role(self):  # TRD s6.2
        f = self.rtext(ACME_ROLE)
        allt = "\n".join(f.values())
        self.assertRegex(allt, r"--key-type\s+ecdsa")
        self.assertRegex(allt, r"--elliptic-curve\s+secp256r1")
        self.assertNotRegex(allt, r"--key-type\s+rsa")
        self.assertRegex(allt, r"/var/www/acme")
        self.assertRegex(allt, r"--deploy-hook|deploy-hook|deploy_hook")
        self.assertRegex(allt, r"nginx -t\s*&&\s*nginx -s reload")
        self.assertRegex(allt, r"OnCalendar=\*-\*-\*\s+\d{1,2},\d{1,2}:|OnCalendar=.*(00|0),(12)|twice", "renewal timer twice daily")
        self.assertRegex(allt, r"staging", "staging ACME directory for dev/staging")
        self.assertRegex(allt, r"internal_ca", "internal-CA option when no public ACME is reachable (done_when)")
        self.assertRegex(allt, r"http-01|--webroot|webroot")

    def test_site_yml_has_the_edge_play(self):
        plays = yaml.safe_load(need(SITE_YML))
        hit = [p for p in plays if {"edge_nginx", "acme"} <= {r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])}]
        self.assertTrue(hit, "site.yml needs a play with roles acme + edge_nginx")
        self.assertIn("app", str(hit[0]["hosts"]))
        self.assertTrue(hit[0].get("become"))


# =============================================================================================== gen-routes.sh
def bash():
    for c in (shutil.which("bash"), r"C:\Program Files\Git\bin\bash.exe"):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def op(extra=None):
    return {"operationId": "o", "responses": {"200": {"description": "ok"}}, **(extra or {})}


FIXTURE = {
    "a.yaml": {"openapi": "3.1.0", "info": {"title": "a", "version": "1"}, "paths": {
        "/v1/instruments/agent/message-batches": {"post": op({"x-edge-exposure": "public"})},
        "/v1/instruments/agent/config": {"get": op({"x-edge-exposure": "public"})},
        "/v1/identity/auth/login": {"post": op({"x-edge-exposure": "internal"})},
        "/v1/identity/users": {"get": op()},  # default internal
        "/v1/engagement/auth/otp-challenges": {"post": op({"x-edge-exposure": "public"})},
        "/v1/identity/auth/patient/session/resolve": {"post": op({"x-edge-exposure": "public"})},
        "/v1/mixed/thing": {"get": op({"x-edge-exposure": "public"}), "post": op({"x-edge-exposure": "internal"})},
    }},
    "b.yaml": {"openapi": "3.1.0", "info": {"title": "b", "version": "1"}, "paths": {
        "/v1/reporting/provider-callbacks/{token}": {"post": op({"x-edge-exposure": "public"}), "get": op({"x-edge-exposure": "public"})},
        "/v1/payments/launch/{token}": {"get": op({"x-edge-exposure": "public"})},
        "/v1/payments/result": {"get": op({"x-edge-exposure": "public"})},
    }},
}


class GenRoutesTest(unittest.TestCase):
    def run_gen(self, spec_dir=None, extra_env=None):
        need(GEN)
        args = [bash(), str(GEN)] + (["--openapi-dir", str(spec_dir)] if spec_dir else [])
        env = dict(os.environ, **(extra_env or {}))
        env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")  # same python (PyYAML) as this run
        return subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=120, env=env)

    def fixture(self, files=FIXTURE):
        d = Path(tempfile.mkdtemp(prefix="t13gen"))
        self.addCleanup(shutil.rmtree, d, True)
        for n, doc in files.items():
            (d / n).write_text(yaml.safe_dump(doc), encoding="utf-8")
        return d

    def test_script_is_not_the_t01_stub(self):
        self.assertNotIn("not implemented yet", need(GEN))

    def test_only_public_operations_in_deterministic_order(self):  # AC-26.1, AC-06.1, CR-C1-004
        r = self.run_gen(self.fixture())
        self.assertEqual(r.returncode, 0, r.stderr)
        doc = yaml.safe_load(r.stdout)
        paths = [x["path"] for x in doc["routes"]]
        flat = " ".join(paths)
        self.assertNotIn("/v1/identity/auth/login", flat)
        self.assertNotIn("/v1/identity/users", flat)
        for want in ("/v1/instruments/agent/", "/v1/engagement/auth/otp-challenges", "/v1/identity/auth/patient/session/resolve",
                     "/v1/reporting/provider-callbacks/", "/v1/payments/launch/", "/v1/payments/result"):
            self.assertIn(want, paths)
        self.assertNotIn("{", r.stdout.replace("{}", ""), "path templates collapse to prefixes")

    def test_zone_and_limits_assigned(self):  # TRD s6.3/6.5
        r = self.run_gen(self.fixture())
        self.assertEqual(r.returncode, 0, r.stderr)
        by = {x["path"]: x for x in yaml.safe_load(r.stdout)["routes"]}
        self.assertEqual(by["/v1/instruments/agent/"]["zone"], "agent")
        self.assertEqual(by["/v1/instruments/agent/"]["body_limit"], "4m")
        self.assertEqual(by["/v1/reporting/provider-callbacks/"]["zone"], "callback")
        self.assertEqual(by["/v1/engagement/auth/otp-challenges"]["zone"], "otp")
        self.assertEqual(by["/v1/identity/auth/patient/session/resolve"]["zone"], "psession")
        self.assertEqual(by["/v1/payments/result"]["match"], "exact")
        self.assertEqual(by["/v1/payments/launch/"]["zone"], "payments")
        self.assertEqual(sorted(by["/v1/payments/launch/"]["methods"]), ["GET"])

    def test_deterministic_and_order_independent(self):
        a = self.run_gen(self.fixture()).stdout
        rev = self.fixture(dict(reversed(list(FIXTURE.items()))))
        self.assertEqual(a, self.run_gen(rev).stdout)
        self.assertEqual(a, self.run_gen(self.fixture()).stdout)
        self.assertNotRegex(a, r"20\d\d-\d\d-\d\d|\bgenerated at\b", "no timestamps: drift job compares bytes")

    def test_invalid_exposure_value_fails_closed(self):  # spec-lint enforced; a typo must not silently mean 'internal' or 'public'
        bad = {"c.yaml": {"openapi": "3.1.0", "info": {"title": "c", "version": "1"},
                          "paths": {"/v1/x/y": {"get": op({"x-edge-exposure": "publc"})}}}}
        r = self.run_gen(self.fixture(bad))
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("/v1/x/y", r.stdout)

    def test_missing_openapi_dir_fails(self):
        r = self.run_gen(Path(tempfile.gettempdir()) / "t13-does-not-exist")
        self.assertNotEqual(r.returncode, 0)

    def test_committed_yaml_equals_generator_output(self):  # done_when: CI job edge-routes-drift
        r = self.run_gen()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(yaml.safe_load(r.stdout), yaml.safe_load(need(ROUTES_YAML)),
                         "public-routes.yaml drifted from ci/gen-routes.sh output - regenerate, never hand-edit")
        self.assertEqual(r.stdout, need(ROUTES_YAML), "byte-identical (the drift job diffs text)")

    def test_committed_yaml_carries_a_generated_banner(self):
        self.assertRegex(need(ROUTES_YAML)[:400], r"(?i)generated.*gen-routes\.sh|gen-routes\.sh")


# =============================================================================================== external suite scripts
class ExternalSuiteTest(unittest.TestCase):
    def txt(self, n):
        return need(EXT / n)

    def test_scripts_exist_and_compile(self):
        for n in ("headers.py", "routes.py", "ratelimit.py"):
            need(EXT / n)
            subprocess.run([sys.executable, "-I", "-c", "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())", str(EXT / n)],
                           check=True, capture_output=True)
        need(EXT / "tls.sh")
        r = subprocess.run([bash(), "-n", str(EXT / "tls.sh")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_fail_closed_without_a_target(self):  # a suite that passes with nothing to test is a lie
        for n in ("headers.py", "routes.py", "ratelimit.py"):
            need(EXT / n)
            env = {k: v for k, v in os.environ.items() if not k.upper().startswith("LIMS")}
            r = subprocess.run([sys.executable, "-I", str(EXT / n)], capture_output=True, text=True, timeout=60, env=env, cwd=tempfile.gettempdir())
            self.assertNotEqual(r.returncode, 0, "%s exited 0 with no target configured" % n)
        env = {k: v for k, v in os.environ.items() if not k.upper().startswith("LIMS")}
        need(EXT / "tls.sh")
        r = subprocess.run([bash(), str(EXT / "tls.sh")], capture_output=True, text=True, timeout=60, env=env, cwd=tempfile.gettempdir())
        self.assertNotEqual(r.returncode, 0)

    def test_tls_sh_checks_the_prd_numbers(self):  # AC-02.1, AC-02.2
        t = self.txt("tls.sh")
        self.assertRegex(t, r"testssl")
        for s in SUITES13:
            self.assertIn(s, t)
        for c in CIPHERS12:
            self.assertTrue(c in t or c.replace("-", "_") in t or re.sub(r"ECDHE-(\w+)-", "", c) in t, c)
        self.assertRegex(t, r"(?i)secp256r1|prime256v1|P-256")
        self.assertRegex(t, r"\b90\b")

    def test_headers_py(self):  # AC-03.1, AC-03.3, AC-04.8
        t = self.txt("headers.py")
        for v in ("max-age=63072000; includeSubDomains", "nosniff", "strict-origin-when-cross-origin", "DENY", "no-referrer", "no-store"):
            self.assertIn(v, t)
        self.assertRegex(t, r"(?i)server")

    def test_routes_py(self):  # AC-06.1, AC-03.2, AC-26.1
        t = self.txt("routes.py")
        self.assertIn("public-routes.yaml", t)
        for p in ("/storage/v1/", "/rest/v1/", "/graphql/v1", "/functions/v1/", "/auth/v1/", "/realtime/v1/", "/pg/", "/api/mcp", "/mcp", "/v1/identity/auth/login"):
            self.assertIn(p, t)

    def test_ratelimit_py(self):  # AC-04.1-4.3a, 4.8-4.10, 08 A27.2 test profile
        t = self.txt("ratelimit.py")
        for token in ("Retry-After", "common.rate_limited", "41", "21", "413", "405", "/v1/payments/", "/v1/instruments/agent/",
                      "provider-callbacks", "otp-challenges", "/v/", "/auth/login"):
            self.assertIn(token, t)
        self.assertRegex(t, r"(?i)lims-ratelimit|source[ _-]?ip|distinct", "A27.2: distinct source IPs or jail disabled")
        self.assertRegex(t, r"4 \* 1024 \* 1024|4194304|4 ?MiB", "AC-04.3a body boundary")
        self.assertIn("SKIP AC-04.10", t, "no otp-challenges route in public-routes.yaml (C16 not shipped) -> SKIP, not FAIL")
        self.assertIn("public-routes.yaml", t)


if __name__ == "__main__":
    unittest.main()
