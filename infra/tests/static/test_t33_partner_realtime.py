"""T-33 tests (tester role): partner origin + Realtime override, both behind flags that are OFF by default.

Plan row: `sites/partner.conf.j2`, `override.realtime.yml`; done_when "configs render and pass `nginx -t` / compose config with
flags on in dev"; tests "config tests". Spec: 02-TRD s6.1/s6.3/s6.5/s6.6 (partner origin), s7.2/s7.3 (Realtime layer, REQ-SEC-036),
s15 (`partner_enabled`, `realtime_enabled`, `realtime_public`), 01-PRD AC-03.1, AC-04.1 (partner-BFF login zone), AC-06.1
(reserved prefixes 404 on partner), C13 02-TRD s2 (partner auth paths) and s493 (flood guard 60 req/min/IP, burst 20 on the
public partner login/recovery routes). LD-45: both topology profiles must render; no host name in either file.

HOW (same approach as T-13/T-05; no nginx binary and no Docker daemon on the test host):
 * partner.conf.j2 is rendered with Jinja2 and parsed by the T-13 mini nginx parser; locations are resolved with nginx's own
   precedence. Real `nginx -t` + sockets: infra/tests/integration/test_t33_live.py (LIMS_T33_LIVE=1, dev VM).
 * override.realtime.yml is rendered with `docker compose config` (CLI only, compose >= 2.24.4) layered exactly as 02-TRD s7.2:
   upstream/docker-compose.yml + override.app.yml + override.realtime.yml.

CONTRACTS where the spec is silent (writer meets them or files a dispute; nothing here is a silent design change):
 * partner.conf.j2, flag ON: one HTTPS server for origins.partner with the shared snippets (server.conf, reserved-deny.conf),
   `client_max_body_size 16m`, `/` -> http://partner:3000, and the partner-BFF login zone on
   `location ~ ^/auth/(login|mfa|mfa/enrol|forgot|confirm|set-password)$` (the six paths of C13 src/app/(auth)/auth/**):
   `limit_req zone=login burst=20 nodelay;` + the perip safety net + `set $retry_after 60;` (exactly staff_web's shape, T-13 ruling).
   This closes the header comment "C13 has not named its login paths yet (T-33)". Security headers on every partner response.
 * partner.conf.j2, flag OFF: renders no server block and no partner host name, and does NOT touch `origins.partner` (the key may
   be absent from the inventory). acme.conf.j2 omits the partner host when off.
 * Nothing about `realtime_*` appears in any nginx site: `/realtime/v1/` is 404 on staff_web, portal, partner AND api whatever
   `realtime_enabled` / `realtime_public` are (02-TRD s6.3: a public realtime websocket only ever appears through a generated
   `public-routes.yaml` entry plus an owner CR; never hand-added).
 * override.realtime.yml (layered LAST over upstream + override.app.yml; the app layer `!reset`s `realtime`, this file re-adds it):
   - re-declares service `realtime` so that the merged app-1 config is exactly {api-gw, auth, rest, storage, imgproxy, realtime}
     and `realtime` depends on no removed service (`db` is `!reset` on app-1);
   - image digest-pinned `supabase/realtime@sha256:<64 hex>`; the file names the snapshot tag v2.148.3; if UPSTREAM.lock `images`
     gains a `realtime` entry the rendered digest must equal it (D-208), otherwise the T-26 placeholder pattern
     (`${REALTIME_IMAGE_DIGEST:-sha256:000...}`, fails closed at pull) is accepted;
   - `container_name` stays `realtime-dev.supabase-realtime` (Realtime derives its tenant id from that name - upstream comment);
   - NO published port, NOT on edge_net/render_net/egress_net/breakglass_net/default; on `db_net` (reaches Postgres at POSTGRES_HOST
     directly, never PgBouncer: logical replication) - and no change to `api-gw` (still no realtime route; REQ-SEC-036);
   - `mem_limit` (<= 2 GiB) and `pids_limit` set (TRD s3.1 "Realtime adds its own limit");
   - `DB_HOST`/`DB_PORT` = POSTGRES_HOST/POSTGRES_PORT, `API_JWT_SECRET` = JWT_SECRET from the env file (no literal secrets);
   - `DB_ENC_KEY` comes from `${REALTIME_DB_ENC_KEY:?...}`: upstream's default `supabaserealtime` must not survive - unset = compose
     config FAILS (fail closed, 02-TRD s8 secret list);
   - no environment key enabling public access (REQ-SEC-036; the self-hosted setting name is UNVERIFIED - the file says so and
     adds nothing that could switch it on); header cites LD-45 and REQ-SEC-036.
 * Flags default OFF in every inventory (partner_enabled, realtime_enabled, realtime_public == false).
Stdlib + PyYAML + Jinja2 + docker CLI (no daemon). Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t33_*.py" -v
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_t05_supabase_compose as t05  # noqa: E402  (helpers only: env_for, docker_ok, closure, nets, constants)
import test_t13_edge as t13  # noqa: E402  (helpers only: nginx parser, render, match_location, ...)

ROOT = t13.ROOT
SITES = t13.SITES
SUPA = t05.SUPA
PARTNER_SITE = SITES / "partner.conf.j2"
OVERRIDE = SUPA / "override.realtime.yml"
LOCK = SUPA / "upstream" / "UPSTREAM.lock"
INVENTORIES = ROOT / "infra" / "ansible" / "inventories"

PARTNER = t13.ORIGINS["partner"]
LOGIN_PATHS = ["/auth/login", "/auth/mfa", "/auth/mfa/enrol", "/auth/forgot", "/auth/confirm", "/auth/set-password"]
APP_PATHS = ["/", "/dashboard", "/orders/123", "/auth/logout", "/auth/session-expired", "/auth/loginx", "/auth/login/x"]
APP_SET = t05.APP_SET
SENTINEL = {"POSTGRES_PASSWORD": "sentinel-pg-pw", "JWT_SECRET": "sentinel-jwt-secret-0123456789abcdef",
            "REALTIME_DB_ENC_KEY": "SENTINELENCKEY16", "POSTGRES_PORT": "5432", "POSTGRES_HOST": t05.DATA_WG}
ZERO = "sha256:" + "0" * 64
HOSTNAMES = t13.HOSTNAME_RE
FLAG_SETS = [dict(partner_enabled=True, realtime_enabled=True, realtime_public=True),
             dict(partner_enabled=True, realtime_enabled=True, realtime_public=False),
             dict(partner_enabled=False, realtime_enabled=False, realtime_public=False)]


def need(path):
    return t13.need(path)


def code_only(text):
    return "\n".join(l.split(" #")[0] if not l.strip().startswith("#") else "" for l in text.splitlines())


def partner_server(profile="full", **kw):
    root = t13.parse_conf(t13.render(PARTNER_SITE, profile=profile, partner_enabled=True, **kw))
    return t13.server_for(root, PARTNER)


# ================================================================================================ nginx: partner origin
class PartnerOriginFlagOnTest(unittest.TestCase):
    def each_profile(self):
        for p in t13.PROFILES:
            yield p, partner_server(p)

    def test_renders_https_server_for_partner_origin_in_every_profile(self):  # done_when; LD-45
        for p, s in self.each_profile():
            self.assertTrue([a for d in s.kids("ssl_certificate") for a in d.args if "/%s/fullchain.pem" % PARTNER in a], p)
            self.assertTrue([a for d in s.kids("ssl_certificate_key") for a in d.args if "/%s/privkey.pem" % PARTNER in a], p)
            self.assertIn(("listen", 443), [("listen", port) for port, _, _ in t13.listens(s)], p)

    def test_template_has_no_host_names_or_hardcoded_origin(self):  # LD-45
        text = need(PARTNER_SITE)
        self.assertIsNone(HOSTNAMES.search(code_only(text)), "host name in partner.conf.j2")
        self.assertRegex(text, r"LD-45|T-33", "cite the decision / task in a comment")
        self.assertNotIn("C13 has not named its login paths yet", text, "stale placeholder comment must go")

    def test_body_limit_is_16m(self):  # 02-TRD s6.6 [CONV same upload cap as staff_web]
        for p, s in self.each_profile():
            self.assertEqual(t13.eff_value(s, None, "client_max_body_size"), ["16m"], p)

    def test_slash_and_app_paths_proxy_to_partner_bff(self):  # AC-06.1 "while / and the app's own paths are served"
        for p, s in self.each_profile():
            for uri in APP_PATHS:
                loc = t13.match_location(s, uri)
                self.assertIsNotNone(loc, (p, uri))
                self.assertEqual([d.args for d in loc.kids("proxy_pass")], [["http://partner:3000"]], (p, uri))
                self.assertEqual(t13.returns(loc), [], (p, uri))

    def test_no_other_upstream_or_user_controlled_proxy_target(self):
        for p, s in self.each_profile():
            for n in t13.walk(s):
                if n.name == "proxy_pass":
                    self.assertEqual(n.args, ["http://partner:3000"], "only the partner BFF may be proxied to (%s)" % p)

    def test_reserved_prefixes_are_404_never_proxied(self):  # AC-06.1, AC-03.2 (incl. /realtime/v1/)
        for p, s in self.each_profile():
            for pre in t13.DENY:
                for uri in (pre, pre + "x" if pre.endswith("/") else pre + "/x"):
                    loc = t13.match_location(s, uri)
                    self.assertIsNotNone(loc, (p, uri))
                    self.assertEqual(t13.returns(loc), [["404"]], "%s %s must be 404" % (p, uri))
                    self.assertFalse(loc.kids("proxy_pass"), "%s %s proxied" % (p, uri))

    def test_supabase_auth_prefix_beats_the_login_regex(self):  # /auth/v1/ is GoTrue, never the BFF /auth/*
        s = partner_server()
        for uri in ("/auth/v1/user", "/auth/v1/token", "/auth/v1/login"):
            self.assertEqual(t13.returns(t13.match_location(s, uri)), [["404"]], uri)

    def test_login_zone_on_the_partner_auth_routes(self):  # AC-04.1 partner part; C13 02-TRD s493
        for p, s in self.each_profile():
            for uri in LOGIN_PATHS:
                loc = t13.match_location(s, uri)
                self.assertEqual(t13.zone_limits(loc), [["zone=login", "burst=20", "nodelay"]], (p, uri))
                self.assertEqual([d.args for d in loc.kids("set") if d.args[0] == "$retry_after"], [["$retry_after", "60"]], (p, uri))
                self.assertEqual([d.args for d in loc.kids("proxy_pass")], [["http://partner:3000"]], (p, uri))

    def test_login_zone_is_not_applied_to_other_paths(self):
        s = partner_server()
        for uri in ("/", "/dashboard", "/auth/logout", "/auth/loginx", "/auth/login/x", "/auth/session-expired", "/r/abc", "/v/abc"):
            self.assertEqual(t13.zone_limits(t13.match_location(s, uri)), [], uri)

    def test_other_zones_never_on_partner(self):  # qrverify is portal-only (08 A13 D-32); otp/psession/agent/callback/payments are api-origin
        text = t13.render(PARTNER_SITE, partner_enabled=True)
        for z in ("qrverify", "otp", "psession", "agent", "callback", "payments"):
            self.assertNotRegex(text, r"zone=%s\b" % z, z)

    def test_security_headers_on_every_partner_response(self):  # AC-03.1
        for p, s in self.each_profile():
            for uri in ["/", "/auth/login", "/auth/confirm", "/auth/mfa/enrol"] + ["/v1/", "/realtime/v1/", "/mcp"]:
                h = t13.headers_of(s, t13.match_location(s, uri))
                for name, value in t13.SEC_HEADERS.items():
                    self.assertEqual(h.get(name.lower()), (value, True), "%s %s %s" % (p, uri, name))

    def test_hsts_has_no_preload(self):  # 04 I6
        self.assertNotIn("preload", t13.render(PARTNER_SITE, partner_enabled=True))

    def test_background_header_not_stripped_on_partner_but_other_lims_headers_are(self):  # 08 A25 D-206 (BFF origins)
        s = partner_server()
        sets = {}
        for n in t13.walk(s):
            if n.name == "proxy_set_header":
                sets.setdefault(n.args[0].lower(), []).append(n.args[1:])
        # inherited strip lives in snippets/proxy.conf (T-13); the partner file must neither undo it nor set a BFF key
        self.assertNotIn(["\"\""], sets.get("x-lims-background", []), "X-Lims-Background must pass through on partner")
        self.assertEqual([v for v in sets.get("x-lims-bff-key", []) if v not in ([""], ['""'])], [], "the edge never sets a BFF key")

    def test_no_dev_leftovers(self):
        text = need(PARTNER_SITE)
        for bad in ("autoindex on", "ssl_protocols TLSv1 ", "listen 80", "return 200", "add_header Access-Control-Allow-Origin *"):
            self.assertNotIn(bad, text)


class PartnerOriginFlagOffTest(unittest.TestCase):
    def test_flag_off_renders_nothing(self):  # "flags off"
        for p in t13.PROFILES:
            out = t13.render(PARTNER_SITE, profile=p, partner_enabled=False)
            self.assertEqual(t13.servers_of(t13.parse(out)), [], p)
            self.assertNotIn(PARTNER, out, p)
            self.assertNotIn("partner:3000", code_only(out), p)

    def test_flag_off_does_not_need_origins_partner(self):  # inventory may omit the key until Wave 2
        origins = {k: v for k, v in t13.ORIGINS.items() if k != "partner"}
        out = t13.render(PARTNER_SITE, partner_enabled=False, origins=origins)
        self.assertEqual(t13.servers_of(t13.parse(out)), [])

    def test_flag_off_acme_has_no_partner_host_and_flag_on_has(self):
        off = t13.render(SITES / "acme.conf.j2", partner_enabled=False)
        on = t13.render(SITES / "acme.conf.j2", partner_enabled=True)
        self.assertNotIn(PARTNER, off)
        self.assertIn(PARTNER, on)

    def test_every_inventory_has_all_three_flags_off(self):  # 02-TRD s15 defaults
        files = sorted(INVENTORIES.glob("*/group_vars/all.yml"))
        self.assertGreaterEqual(len(files), 5, "dev, staging, staging-lean, prod, prod-lean")
        for f in files:
            data = yaml.safe_load(f.read_text(encoding="utf-8"))
            for flag in ("partner_enabled", "realtime_enabled", "realtime_public"):
                self.assertIs(data.get(flag), False, "%s: %s must default to false" % (f.parent.parent.name, flag))


class RealtimeNeverReachesNginxTest(unittest.TestCase):
    def test_realtime_path_is_404_on_every_origin_for_any_flag_combination(self):  # REQ-SEC-036; 02-TRD s6.3 last paragraph
        for flags in FLAG_SETS:
            for name in ("staff_web", "portal", "partner", "api"):
                if name == "partner" and not flags["partner_enabled"]:
                    continue
                s = t13.server_for(t13.site(name, **flags), t13.ORIGINS[name])
                for uri in ("/realtime/v1/", "/realtime/v1/websocket", "/realtime/v1/api/tenants"):
                    loc = t13.match_location(s, uri)
                    self.assertIsNotNone(loc, (name, uri, flags))
                    self.assertEqual(t13.returns(loc), [["404"]], (name, uri, flags))
                    self.assertFalse(loc.kids("proxy_pass"), (name, uri, flags))

    def test_api_site_render_is_independent_of_realtime_flags(self):  # nothing hand-added; only generated public-routes.yaml
        base = t13.render(SITES / "api.conf.j2", realtime_enabled=False, realtime_public=False)
        for en, pub in ((True, False), (True, True), (False, True)):
            self.assertEqual(t13.render(SITES / "api.conf.j2", realtime_enabled=en, realtime_public=pub), base, (en, pub))

    def test_no_realtime_proxy_anywhere_in_edge_tree(self):
        for f in list((t13.NGX).rglob("*.conf")) + list(SITES.glob("*.j2")):
            code = code_only(f.read_text(encoding="utf-8"))
            for m in re.finditer(r"proxy_pass\s+[^;]*realtime[^;]*;", code, re.I):
                self.fail("%s proxies to realtime: %s" % (f.name, m.group(0)))
        routes = t13.load_routes()
        self.assertFalse([r for r in routes if "realtime" in r["path"]], "public-routes.yaml must not list a realtime path")


# ================================================================================================ compose: Realtime override
def compose(files, drop=(), extra_env=None):
    """docker compose config --format json over SUPA/files. Returns (returncode, parsed|None, stderr)."""
    t05.docker_ok()
    for f in files:
        if not (SUPA / f).is_file():
            raise AssertionError("missing file infra/compose/supabase/%s" % f)
    env = t05.env_for(t05.APP_WG, files)
    env.update(SENTINEL)
    env.update(extra_env or {})
    for k in drop:
        env.pop(k, None)
    penv = {k: v for k, v in os.environ.items() if k not in env and k not in drop}
    with tempfile.TemporaryDirectory() as td:
        ef = Path(td) / "env"
        ef.write_text("".join("%s=%s\n" % kv for kv in env.items()), encoding="utf-8")
        cmd = ["docker", "compose", "--project-directory", str(SUPA), "-p", "supabase", "--env-file", str(ef)]
        for f in files:
            cmd += ["-f", str(SUPA / f)]
        r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True, timeout=120, env=penv)
    return r.returncode, (json.loads(r.stdout) if r.returncode == 0 else None), r.stderr


LAYERS_OFF = ["upstream/docker-compose.yml", "override.app.yml"]
LAYERS_ON = LAYERS_OFF + ["override.realtime.yml"]
_cache = {}


def cfg(key):
    if key not in _cache:
        files = LAYERS_ON if key == "on" else LAYERS_OFF
        rc, data, err = compose(files)
        if rc:
            raise AssertionError("docker compose config failed (%s layers):\n%s" % (key, err.strip()[-1500:]))
        _cache[key] = data
    return _cache[key]


def rt():
    s = cfg("on")["services"].get("realtime")
    if s is None:
        raise AssertionError("service realtime missing after layering override.realtime.yml")
    return s


def lock_images():
    return (yaml.safe_load(need(LOCK)) or {}).get("images") or {}


class RealtimeOverrideFileTest(unittest.TestCase):
    def test_file_exists_and_cites_decisions(self):
        text = need(OVERRIDE)
        for token in ("LD-45", "REQ-SEC-036", "UNVERIFIED", "v2.148.3"):
            self.assertIn(token, text, "override.realtime.yml must mention %s" % token)

    def test_no_host_names_in_code(self):  # LD-45
        self.assertIsNone(HOSTNAMES.search(code_only(need(OVERRIDE))))

    def test_no_literal_secrets(self):
        for i, line in enumerate(code_only(need(OVERRIDE)).splitlines(), 1):
            m = re.match(r"^\s+([A-Z][A-Z0-9_]*):\s*(.+?)\s*$", line)
            if m and re.search(r"KEY|SECRET|PASSWORD|TOKEN|ENC", m.group(1)):
                self.assertTrue(m.group(2).strip("\"'").startswith("${"), "line %d: %s must come from the env file" % (i, m.group(1)))

    def test_db_enc_key_has_no_upstream_default(self):
        text = code_only(need(OVERRIDE))
        self.assertNotIn("supabaserealtime", text.replace("realtime-dev.supabase-realtime", ""))
        self.assertRegex(text, r"\$\{REALTIME_DB_ENC_KEY:\?")

    def test_does_not_touch_other_services(self):
        data = yaml.load(need(OVERRIDE).replace("!override", "").replace("!reset", ""), Loader=yaml.SafeLoader)
        self.assertEqual(sorted((data.get("services") or {}).keys()), ["realtime"], "override.realtime.yml may only define `realtime`")
        self.assertFalse([k for k in data if k not in ("services", "x-realtime")], "no new networks/volumes/secrets blocks")


class RealtimeOverrideComposeTest(unittest.TestCase):
    def test_app_layers_alone_have_no_realtime(self):  # flag off = file not passed = baseline untouched
        self.assertEqual(set(cfg("off")["services"]), APP_SET)

    def test_with_override_services_are_exactly_app_set_plus_realtime(self):  # done_when: compose config passes
        self.assertEqual(set(cfg("on")["services"]), APP_SET | {"realtime"})

    def test_realtime_depends_on_no_removed_service(self):
        self.assertEqual(t05.closure(cfg("on"), {"realtime"}), {"realtime"})

    def test_everything_but_realtime_is_unchanged(self):  # the override adds a service, it edits none (api-gw keeps no realtime route)
        off, on = cfg("off")["services"], cfg("on")["services"]
        for name in APP_SET:
            self.assertEqual(on[name], off[name], "%s changed by override.realtime.yml" % name)
        self.assertEqual(cfg("on").get("networks"), cfg("off").get("networks"))

    def test_image_is_digest_pinned_to_the_lock_when_the_lock_has_it(self):  # D-208
        img = rt()["image"]
        m = re.fullmatch(r"supabase/realtime@(sha256:[0-9a-f]{64})", img)
        self.assertIsNotNone(m, "image must be supabase/realtime@sha256:<64 hex>, got %r" % img)
        pinned = lock_images().get("realtime")
        if pinned:
            self.assertEqual(m.group(1), pinned["digest"])
            self.assertEqual(pinned["image"], "supabase/realtime")
            self.assertEqual(pinned["tag"], "v2.148.3")
        else:
            self.assertEqual(m.group(1), ZERO, "no lock entry: only the fail-closed placeholder digest is allowed")

    def test_snapshot_tag_matches_upstream_compose(self):
        up = need(SUPA / "upstream" / "docker-compose.yml")
        self.assertIn("image: supabase/realtime:v2.148.3", up)
        self.assertIn("v2.148.3", need(OVERRIDE))

    def test_container_name_keeps_tenant_id_form(self):
        self.assertEqual(rt().get("container_name"), "realtime-dev.supabase-realtime")

    def test_no_published_ports(self):  # 04 S6 / AC-06.2 spirit; AC-01.3
        self.assertFalse(rt().get("ports"), rt().get("ports"))

    def test_networks_db_only_not_public(self):  # reaches Postgres on db_net; nothing public
        n = t05.nets(rt())
        self.assertIn("db_net", n)
        self.assertEqual(n & {"edge_net", "render_net", "egress_net", "breakglass_net", "default"}, set(), n)
        self.assertLessEqual(n, {"app_net", "db_net"}, n)

    def test_limits_set(self):  # 02-TRD s3.1 "Realtime adds its own limit"
        s = rt()
        self.assertGreater(int(s.get("mem_limit", 0)), 0)
        self.assertLessEqual(int(s["mem_limit"]), 2 * 1024 ** 3)
        self.assertGreater(int(s.get("pids_limit", 0)), 0)

    def test_database_wiring_comes_from_env_and_is_direct(self):  # logical replication => never PgBouncer
        e = rt()["environment"]
        self.assertEqual(e.get("DB_HOST"), SENTINEL["POSTGRES_HOST"])
        self.assertEqual(e.get("DB_PORT"), "5432")
        self.assertEqual(e.get("DB_PASSWORD"), SENTINEL["POSTGRES_PASSWORD"])
        self.assertEqual(e.get("API_JWT_SECRET"), SENTINEL["JWT_SECRET"])
        self.assertEqual(e.get("DB_ENC_KEY"), SENTINEL["REALTIME_DB_ENC_KEY"])
        self.assertNotEqual(e.get("DB_PORT"), "6432")

    def test_db_enc_key_unset_fails_closed(self):  # no `supabaserealtime` upstream default (02-TRD s8)
        rc, _, err = compose(LAYERS_ON, drop=("REALTIME_DB_ENC_KEY",))
        self.assertNotEqual(rc, 0, "compose config must fail when REALTIME_DB_ENC_KEY is unset")
        self.assertIn("REALTIME_DB_ENC_KEY", err)

    def test_db_enc_key_is_exactly_16_chars_in_the_sentinel_run(self):
        self.assertEqual(len(rt()["environment"]["DB_ENC_KEY"]), 16)

    def test_no_public_access_switch(self):  # REQ-SEC-036 / 04 S5: "Allow public access" off; setting name UNVERIFIED
        for k, v in rt()["environment"].items():
            if re.search(r"PUBLIC|ANON|ALLOW", k, re.I):
                self.assertNotIn(str(v).lower(), ("true", "1", "yes", "on"), "%s=%s may enable public access" % (k, v))
            if re.search(r"PRIVATE_ONLY", k, re.I):
                self.assertIn(str(v).lower(), ("true", "1"), k)

    def test_healthcheck_retained(self):
        self.assertTrue(rt().get("healthcheck", {}).get("test"))

    def test_restart_policy_is_not_always_resurrecting_after_stop(self):
        self.assertIn(rt().get("restart", "no"), ("unless-stopped", "on-failure", "no"))


if __name__ == "__main__":
    unittest.main()
