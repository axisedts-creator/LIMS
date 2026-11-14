"""T-17 tests (tester role): logging - Fluent Bit -> VictoriaLogs, scrub.lua, nginx JSON ingest, ops_audit stream.

Covers 06-PLAN row T-17 (done_when: logs searchable < 60 s; planted synthetic PHI-like fields redacted by scrub.lua; retention
90 d; compression ratio measured and recorded), AC-18.1 (ship < 60 s, retained 90 d), AC-18.4 (route templates only, no query
string in any log line), 02-TRD s6.7, s10.1, s10.2, s3.3 (Fluent Bit metrics on the wg IP, :2020), s11.x (log-to-metrics),
02-CONVENTIONS s9.2 (PHI/secret denylist), 07-SEC (REQ-SEC-098, AB-11, AB-16, "Log PHI scan" row), LD-45 (both profiles; no host
name / wg IP in committed logging files).

NOT provable here (no Lua interpreter, Fluent Bit, VictoriaLogs or Docker on this machine): the scrub.lua BEHAVIOUR tests run
only when `lua`/`luajit` is on PATH (otherwise ONE visible skip per test - the static scrub.lua checks still run); real ingest
latency, real compression ratio and retention in the running store live in infra/tests/integration/test_t17_live.py
(LIMS_T17_LIVE=1, Docker). Everything else here is static and must pass without them.

CONTRACTS where the spec is silent (the writer meets them; ambiguity -> dispute, not a silent change):
 * Files: infra/logging/fluent-bit/{fluent-bit.conf.j2,parsers.conf,scrub.lua}, infra/logging/victorialogs/flags.env,
   infra/logging/DECISION.md, role infra/ansible/roles/logging (defaults/, tasks/, templates/), own play(s) in site.yml with
   `hosts: all` (or a union covering data, app, ops, dr and backup) after "Host baseline".
 * Jinja context of fluent-bit.conf.j2: inventory_hostname, wg_ip (own wg IP), groups, hostvars[h].wg_ip, group_names,
   topology_profile, env, site. Unknown variables render as UNDEF_<name> (a conf containing UNDEF_ fails). Classic Fluent Bit
   format (sections [SERVICE] [INPUT] [FILTER] [OUTPUT]). `parsers.conf` is plain.
 * [SERVICE]: `Flush` <= 5 (60 s budget), `Parsers_File` parsers.conf, `HTTP_Server On`, `HTTP_Listen` = own wg IP (never
   0.0.0.0), `HTTP_Port` 2020, `storage.path` set. Every [INPUT] has an explicit `Tag` and `storage.type filesystem`.
 * Inputs: Docker json-file (`tail`, Path /var/lib/docker/containers/*/*-json.log, Parser docker, DB set); journald
   (`systemd`); nginx access.json (`tail`, Path /var/log/nginx/access.json, a JSON parser) ONLY on hosts in group `app`.
 * [FILTER] `lua` (script ...scrub.lua, call cb_filter) after every `parser` filter, Match covering every input Tag. Adds
   host=<inventory_hostname>, env, site with a `record_modifier` filter (`Record host <h>` / `Record env <e>` / `Record site <s>`).
 * [OUTPUT]: only `http`; Host = wg IP of groups['ops'][0] (127.0.0.1 allowed on the ops host itself), Port 9428,
   URI starts /insert/jsonline and carries `_stream_fields=` naming service, env and host; Format json_lines; Retry_Limit
   bounded or unlimited but never `no_retries`; `storage.total_limit_size` 1G (TRD s10.1: 1 GiB cap); no stdout/file outputs.
 * ops_audit: journald lines with SYSLOG_IDENTIFIER ops_audit (infra/ci/ops-note.sh: `logger -t ops_audit`, MESSAGE is the JSON
   {"stream":"ops_audit","who","host","what","when"}) are parsed and routed so the stream is queryable as ops_audit; the
   rendered conf names ops_audit. scrub.lua must keep who/what/when intact.
 * scrub.lua: Fluent Bit Lua filter `cb_filter(tag, timestamp, record)` -> code, timestamp, record. Code 1 when the record was
   changed, 2 only if the timestamp is kept, 0 when untouched, -1 only to drop a whole record; never an error on odd types.
   Denylist = case-insensitive SUBSTRINGS of the key at any nesting depth (02-CONVENTIONS s9.2, TRD s10.1); sensitive keys are
   removed or their value replaced - the original sensitive text must appear nowhere in the output (keys or values). Value
   scrubbers: Nepal-style phone numbers (10 digits starting 9, optional +977 / separators), `Bearer <token>`, JWT (eyJ...).
   UUIDs, IPs, ISO timestamps, request ids and fiscal numbers must survive intact. Defence in depth for AC-18.4: any string
   value under a URL-ish key (uri url path request_uri query query_string args) loses its `?...` part (or the key is dropped).
 * flags.env: `-retentionPeriod=90d` (the only retention flag), `-storageDataPath=`, `-httpListenAddr=` never 0.0.0.0/bare port.
 * DECISION.md: heading with `Compression ratio` and a measured number (`<n>x` or `<n>×`) >= 2.5 (TRD s14) or a cited
   `.orchestra/cr/` file; heading with `Log-to-metrics` and the verdict word AVAILABLE or UNAVAILABLE (UNAVAILABLE cites a
   fallback and `.orchestra/cr/`; AVAILABLE => the rendered conf has a `log_to_metrics` filter); heading with `Ingest endpoint`
   naming /insert/jsonline and the pinned VictoriaLogs version 1.53.0.
 * Role: defaults pin fluent-bit 5.1.5 and victoria-logs 1.53.0 (no `latest`); container templates (fluent-bit, victoria-logs)
   set mem_limit, cap_drop ALL, read_only true, no-new-privileges, no docker.sock, no privileged; every published port has an
   explicit IP (no 0.0.0.0, no bare port); tasks assert the ops host exists (fail closed).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t17_*.py" -v
"""
import fnmatch
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
LOG = ROOT / "infra" / "logging"
CONF_J2 = LOG / "fluent-bit" / "fluent-bit.conf.j2"
PARSERS = LOG / "fluent-bit" / "parsers.conf"
SCRUB = LOG / "fluent-bit" / "scrub.lua"
FLAGS = LOG / "victorialogs" / "flags.env"
DECISION = LOG / "DECISION.md"
ROLE = ROOT / "infra" / "ansible" / "roles" / "logging"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
NGINX_LOGFORMAT = ROOT / "infra" / "edge" / "nginx" / "snippets" / "logformat.conf"
OPSNOTE = ROOT / "infra" / "ci" / "ops-note.sh"
HOSTNAME_RE = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")
WGIP_RE = re.compile(r"\b10\.(77|79)\.\d{1,3}\.\d{1,3}\b")

PROFILES = {  # LD-45
    "full": {"groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]},
             "ip": {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"}},
    "lean": {"groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": [], "backup": ["backup-1"]},
             "ip": {"prod-1": "10.77.0.11", "backup-1": "10.77.0.51"}},
    "dev": {"groups": {"data": ["dev-1"], "app": ["dev-1"], "ops": ["dev-1"], "dr": []}, "ip": {"dev-1": "10.79.0.11"}},
}


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


ENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)


def need(path):
    p = Path(path)
    if not p.is_file():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p.read_text(encoding="utf-8")


def role_text(*subdirs):
    if not ROLE.is_dir():
        raise AssertionError("missing dir infra/ansible/roles/logging")
    out = {}
    for p in sorted(ROLE.rglob("*")):
        if p.is_file() and (not subdirs or p.relative_to(ROLE).parts[0] in subdirs):
            out[p.relative_to(ROLE).as_posix()] = p.read_text(encoding="utf-8")
    if not out:
        raise AssertionError("roles/logging has no files in %s" % (subdirs or "any dir"))
    return out


def ctx(profile, host, env="staging", site="A"):
    p = PROFILES[profile]
    groups = {g: list(h) for g, h in p["groups"].items()}
    hv = {h: {"wg_ip": ip, "ansible_host": ip, "inventory_hostname": h} for h, ip in p["ip"].items()}
    return {"inventory_hostname": host, "wg_ip": p["ip"][host], "groups": groups, "hostvars": hv,
            "group_names": [g for g, hs in groups.items() if host in hs], "topology_profile": profile, "env": env, "site": site,
            "ansible_host": p["ip"][host]}


def all_hosts(profile):
    return sorted(PROFILES[profile]["ip"])


def render_conf(profile, host, **kw):
    c = ctx(profile, host, **kw)
    return ENV.from_string(need(CONF_J2)).render(**c), c


def parse_conf(text):
    """Classic Fluent Bit config -> list of (SECTION, {lowercased key: value}); duplicate keys keep a list under key + '#all'."""
    secs, cur = [], None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^\[(\w+)\]$", line)
        if m:
            cur = (m.group(1).upper(), {})
            secs.append(cur)
            continue
        if cur is None:
            raise AssertionError("key outside a section: %r" % line)
        k, _, v = line.partition(" ")
        cur[1].setdefault(k.lower(), v.strip())
        cur[1].setdefault("#all:" + k.lower(), []).append(v.strip())
    return secs


def sections(secs, name):
    return [s[1] for s in secs if s[0] == name]


def to_bytes_gib(s):
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([kmgKMG]?)i?[bB]?$", s.strip())
    if not m:
        return None
    mult = {"": 1, "k": 1024, "m": 1024 ** 2, "g": 1024 ** 3}[m.group(2).lower()]
    return float(m.group(1)) * mult


# ------------------------------------------------------------------ layout and pins
class LayoutTest(unittest.TestCase):
    def test_files_exist(self):
        for p in (CONF_J2, PARSERS, SCRUB, FLAGS, DECISION):
            need(p)
        for d in ("defaults", "tasks", "templates"):
            self.assertTrue((ROLE / d).is_dir(), "roles/logging/%s missing" % d)

    def test_no_hardcoded_hosts_or_wg_ips(self):  # LD-45: names/IPs come from the active inventory
        files = [CONF_J2, PARSERS, SCRUB, FLAGS] + [p for p in ROLE.rglob("*") if p.is_file()]
        for p in files:
            t = need(p)
            self.assertIsNone(HOSTNAME_RE.search(t), "%s hard-codes a host name" % p.relative_to(ROOT).as_posix())
            self.assertIsNone(WGIP_RE.search(t), "%s hard-codes a wg IP" % p.relative_to(ROOT).as_posix())

    def test_versions_pinned_no_latest(self):
        t = "\n".join(role_text().values())
        self.assertIn("5.1.5", t, "Fluent Bit 5.1.5 (TRD s2)")
        self.assertIn("1.53.0", t, "VictoriaLogs 1.53.0 (TRD s2)")
        self.assertNotRegex(t, r"(?i):latest\b|tag:\s*latest")

    def test_site_yml_has_logging_play_on_all_hosts_after_baseline(self):
        plays = yaml.safe_load(need(SITE))
        idx = [i for i, p in enumerate(plays) if "logging" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertTrue(idx, "no play runs role logging")
        base = [i for i, p in enumerate(plays) if p.get("name") == "Host baseline"]
        self.assertTrue(base and min(idx) > base[0], "logging must come after Host baseline (docker, wireguard)")
        covered = set()
        for i in idx:
            hosts = str(plays[i]["hosts"])
            covered |= {"data", "app", "ops", "dr", "backup"} if hosts.strip() == "all" else set(re.split(r"[:,\s]+", hosts))
        self.assertTrue({"data", "app", "ops", "dr", "backup"} <= covered, "logging plays cover only %s" % sorted(covered))

    def test_tasks_fail_closed_without_an_ops_host(self):
        t = role_text("tasks")
        blob = "\n".join(t.values())
        self.assertRegex(blob, r"(?s)assert.*?groups\[\s*['\"]ops['\"]\s*\]", "assert that group ops is non-empty")


# ------------------------------------------------------------------ VictoriaLogs flags and decision record
class FlagsAndDecisionTest(unittest.TestCase):
    def flags(self):
        t = need(FLAGS)
        return [l.strip() for l in t.splitlines() if l.strip() and not l.strip().startswith("#")]

    def test_retention_is_90_days_and_only_once(self):
        fl = [l for l in self.flags() if "retentionPeriod" in l]
        self.assertEqual(len(fl), 1, "exactly one -retentionPeriod flag: %s" % fl)
        self.assertRegex(fl[0], r"(^|[=\s])-{1,2}retentionPeriod=90d\b")

    def test_data_path_and_listen_address(self):
        text = "\n".join(self.flags())
        self.assertRegex(text, r"-storageDataPath=\S+")
        m = re.search(r"-httpListenAddr=(\S+)", text)
        self.assertIsNotNone(m, "-httpListenAddr missing")
        self.assertNotRegex(m.group(1), r"^(0\.0\.0\.0)?:\d+$|^\[::\]", "VictoriaLogs must not listen on all interfaces (AC-01)")

    def test_decision_compression_ratio_recorded(self):
        t = need(DECISION)
        m = re.search(r"(?im)^#+[^\n]*compression ratio[^\n]*$(.*?)(?=^#+ |\Z)", t, re.S)
        self.assertIsNotNone(m, "DECISION.md needs a heading containing 'Compression ratio'")
        body = m.group(0)
        num = re.search(r"(\d+(?:\.\d+)?)\s*(?:x|×)", body)
        self.assertTrue(num or ".orchestra/cr/" in body, "measured ratio '<n>x' or a cited .orchestra/cr/ file")
        if num:
            self.assertGreaterEqual(float(num.group(1)), 2.5, "TRD s14: < 2.5x needs a CR that shortens retention")
        self.assertRegex(body, r"(?i)measured|sample|synthetic", "say what was measured")

    def test_decision_log_to_metrics_verdict(self):
        t = need(DECISION)
        m = re.search(r"(?im)^#+[^\n]*log-to-metrics[^\n]*$(.*?)(?=^#+ |\Z)", t, re.S)
        self.assertIsNotNone(m, "DECISION.md needs a heading containing 'Log-to-metrics'")
        verdict = re.findall(r"\b(UNAVAILABLE|AVAILABLE)\b", m.group(0))
        self.assertTrue(verdict, "verdict word AVAILABLE or UNAVAILABLE")
        if verdict[0] == "UNAVAILABLE":
            self.assertIn(".orchestra/cr/", m.group(0))
        else:
            text, _ = render_conf("lean", "prod-1")
            self.assertRegex(text, r"(?i)log_to_metrics", "AVAILABLE => the conf uses the log_to_metrics filter")

    def test_decision_ingest_endpoint(self):
        t = need(DECISION)
        m = re.search(r"(?im)^#+[^\n]*ingest endpoint[^\n]*$(.*?)(?=^#+ |\Z)", t, re.S)
        self.assertIsNotNone(m, "DECISION.md needs a heading containing 'Ingest endpoint'")
        self.assertIn("/insert/jsonline", m.group(0))
        self.assertIn("1.53.0", m.group(0))


# ------------------------------------------------------------------ rendered Fluent Bit config, both profiles
class RenderedConfTest(unittest.TestCase):
    def each(self):
        for prof in PROFILES:
            for host in all_hosts(prof):
                text, c = render_conf(prof, host)
                self.assertNotIn("UNDEF_", text, "%s/%s: unresolved variable" % (prof, host))
                self.assertIsNone(re.search(r"\{\{|\{%", text), "%s/%s: unrendered jinja" % (prof, host))
                yield prof, host, c, text, parse_conf(text)

    def test_service_section(self):
        for prof, host, c, text, secs in self.each():
            svc = sections(secs, "SERVICE")
            self.assertEqual(len(svc), 1, "%s/%s" % (prof, host))
            s = svc[0]
            self.assertLessEqual(float(s["flush"]), 5, "%s/%s: Flush must be <= 5 s (searchable < 60 s)" % (prof, host))
            self.assertEqual(s["http_server"].lower(), "on")
            self.assertEqual(s["http_listen"], c["wg_ip"], "%s/%s: metrics only on the wg IP (TRD s3.3)" % (prof, host))
            self.assertEqual(s["http_port"], "2020")
            self.assertTrue(s.get("storage.path"), "storage.path")
            self.assertIn("parsers.conf", s.get("parsers_file", ""))

    def test_health_check_on_because_role_probes_api_v1_health(self):
        # review T-17: Fluent Bit serves /api/v1/health only with Health_Check On; the role waits on it.
        self.assertIn("/api/v1/health", "\n".join(role_text("tasks").values()), "role no longer probes /api/v1/health; drop this test")
        for prof, host, c, text, secs in self.each():
            s = sections(secs, "SERVICE")[0]
            self.assertEqual(s.get("health_check", "").lower(), "on", "%s/%s: [SERVICE] needs Health_Check On" % (prof, host))

    def test_inputs_tagged_and_buffered_to_disk(self):
        for prof, host, c, text, secs in self.each():
            ins = sections(secs, "INPUT")
            self.assertGreaterEqual(len(ins), 2, "%s/%s: docker + journald at least" % (prof, host))
            for i in ins:
                self.assertTrue(i.get("tag"), "%s/%s: every INPUT needs an explicit Tag" % (prof, host))
                self.assertEqual(i.get("storage.type"), "filesystem", "%s/%s: %s" % (prof, host, i.get("tag")))

    def test_docker_and_journald_inputs(self):
        for prof, host, c, text, secs in self.each():
            ins = sections(secs, "INPUT")
            docker = [i for i in ins if "/var/lib/docker/containers/" in i.get("path", "")]
            self.assertEqual(len(docker), 1, "%s/%s" % (prof, host))
            d = docker[0]
            self.assertEqual(d["name"], "tail")
            self.assertTrue(d["path"].endswith("*-json.log"))
            self.assertEqual(d.get("parser"), "docker")
            self.assertTrue(d.get("db"), "DB offset file (no re-read after restart)")
            self.assertEqual(len([i for i in ins if i["name"] == "systemd"]), 1, "%s/%s: one journald input" % (prof, host))

    def test_nginx_input_only_on_app_hosts(self):
        for prof, host, c, text, secs in self.each():
            ng = [i for i in sections(secs, "INPUT") if "access.json" in i.get("path", "")]
            if "app" in c["group_names"]:
                self.assertEqual(len(ng), 1, "%s/%s: nginx access.json input expected" % (prof, host))
                self.assertEqual(ng[0]["path"], "/var/log/nginx/access.json")
                self.assertTrue(ng[0].get("parser"), "JSON parser for access.json")
            else:
                self.assertEqual(ng, [], "%s/%s: no nginx here" % (prof, host))

    def test_lua_scrub_filter_present_ordered_and_matching_all_inputs(self):
        for prof, host, c, text, secs in self.each():
            filt = [s for s in secs if s[0] == "FILTER"]
            lua = [f for f in filt if f[1].get("name") == "lua"]
            self.assertEqual(len(lua), 1, "%s/%s: exactly one lua filter" % (prof, host))
            lf = lua[0][1]
            self.assertTrue(lf["script"].endswith("scrub.lua"))
            self.assertEqual(lf["call"], "cb_filter")
            pos = filt.index(lua[0])
            for i, f in enumerate(filt):
                if f[1].get("name") in ("parser", "nest", "multiline"):
                    self.assertLess(i, pos, "%s/%s: parse before scrub" % (prof, host))
            for i in sections(secs, "INPUT"):
                self.assertTrue(fnmatch.fnmatchcase(i["tag"], lf["match"]), "%s/%s: scrub does not match tag %s" % (prof, host, i["tag"]))

    def test_host_env_site_added(self):
        for prof, host, c, text, secs in self.each():
            for k, v in (("host", host), ("env", c["env"]), ("site", c["site"])):
                self.assertRegex(text, r"(?mi)^\s*Record\s+%s\s+%s\s*$" % (k, re.escape(v)), "%s/%s: record_modifier Record %s" % (prof, host, k))

    def test_output_goes_to_victorialogs_over_wg0_only(self):
        for prof, host, c, text, secs in self.each():
            outs = sections(secs, "OUTPUT")
            self.assertTrue(outs, "%s/%s: no OUTPUT" % (prof, host))
            ops_host = c["groups"]["ops"][0]
            ok_hosts = {c["hostvars"][ops_host]["wg_ip"]} | ({"127.0.0.1"} if host == ops_host else set())
            for o in outs:
                self.assertEqual(o["name"], "http", "%s/%s: only http outputs (no stdout/file leaks)" % (prof, host))
                self.assertIn(o["host"], ok_hosts, "%s/%s: Host must be the ops wg IP" % (prof, host))
                self.assertEqual(o["port"], "9428")
                self.assertTrue(o["uri"].startswith("/insert/jsonline"), o["uri"])
                m = re.search(r"_stream_fields=([^&]+)", o["uri"])
                self.assertIsNotNone(m, "_stream_fields in URI")
                for f in ("service", "env", "host"):
                    self.assertIn(f, m.group(1).split(","), "stream field %s" % f)
                self.assertEqual(o["format"], "json_lines")
                self.assertNotEqual(o.get("retry_limit", "").lower(), "no_retries")
                self.assertNotIn(o.get("tls", "off").lower(), ("on",), "wg0 carries it; keep plain (no cert to manage)")
                self.assertIn(o.get("storage.total_limit_size", "").upper().replace("IB", "").replace("B", ""), ("1G", "1024M"),
                              "%s/%s: 1 GiB disk buffer cap (TRD s10.1)" % (prof, host))
                self.assertEqual(o["match"] in ("*",) or all(fnmatch.fnmatchcase(i["tag"], o["match"]) for i in sections(secs, "INPUT")), True)

    def test_ops_audit_routed(self):
        for prof, host, c, text, secs in self.each():
            self.assertIn("ops_audit", text, "%s/%s: ops_audit stream not mentioned" % (prof, host))
            self.assertIn("SYSLOG_IDENTIFIER", text, "%s/%s: select journald lines by SYSLOG_IDENTIFIER" % (prof, host))

    def test_no_query_string_or_credential_header_fields_in_any_log_path(self):  # AC-18.4
        for prof, host, c, text, secs in self.each():
            self.assertIsNone(re.search(r"\$args|\$request_uri|\$query_string|\$http_(cookie|authorization|referer)", text), "%s/%s" % (prof, host))
        nginx = need(NGINX_LOGFORMAT)
        fmt = re.search(r"log_format\s+\w+[^'\"]*(['\"].*?['\"]);", nginx, re.S).group(1)
        self.assertIsNone(re.search(r"\$args|\$request_uri|\$query_string|\$request\b|\$http_(cookie|authorization|referer)|\$remote_user", fmt))

    def test_parsers(self):
        secs = parse_conf(need(PARSERS))
        by = {p["name"]: p for p in sections(secs, "PARSER")}
        self.assertIn("docker", by)
        self.assertEqual(by["docker"]["format"], "json")
        self.assertEqual(by["docker"].get("time_key"), "time")
        js = [p for n, p in by.items() if n != "docker" and p.get("format") == "json" and p.get("time_key") == "ts"]
        self.assertTrue(js, "a JSON parser with Time_Key ts for nginx access.json (log_format has ts)")
        self.assertTrue(js[0].get("time_format"))

    def test_full_profile_ships_from_every_host_and_lean_includes_backup(self):
        text, c = render_conf("lean", "backup-1")
        o = sections(parse_conf(text), "OUTPUT")[0]
        self.assertEqual(o["host"], "10.77.0.11", "backup-1 ships to prod-1 (the ops host) over wg0")
        text, c = render_conf("full", "data-1")
        self.assertEqual(sections(parse_conf(text), "OUTPUT")[0]["host"], "10.79.0.14")


# ------------------------------------------------------------------ role templates (compose-level hardening)
class RoleTemplatesTest(unittest.TestCase):
    def container_templates(self):
        t = role_text("templates")
        fb = {k: v for k, v in t.items() if re.search(r"(?i)fluent", k + v[:400])}
        vl = {k: v for k, v in t.items() if re.search(r"(?i)victoria", k + v[:400])}
        self.assertTrue(fb, "no Fluent Bit container template")
        self.assertTrue(vl, "no VictoriaLogs container template")
        return fb, vl

    def test_hardening_keys(self):
        for group in self.container_templates():
            blob = "\n".join(group.values())
            self.assertRegex(blob, r"mem_limit\s*:")
            self.assertRegex(blob, r"cap_drop\s*:\s*\n?\s*(-\s*)?\[?\s*['\"]?ALL")
            self.assertRegex(blob, r"read_only\s*:\s*true")
            self.assertRegex(blob, r"no-new-privileges\s*:?\s*true")
            self.assertNotRegex(blob, r"docker\.sock|privileged\s*:\s*true|pid\s*:\s*['\"]?host")

    def test_published_ports_have_explicit_ip(self):
        fb, vl = self.container_templates()
        for name, blob in {**fb, **vl}.items():
            for m in re.finditer(r"^\s*-\s*['\"]?([^'\"\s]+:\d+(?::\d+)?)['\"]?\s*$", blob, re.M):
                spec = m.group(1)
                if spec.count(":") >= 2:
                    ip = spec.split(":")[0]
                    self.assertNotIn(ip, ("0.0.0.0", ""), "%s publishes %s" % (name, spec))
                    self.assertTrue(ip, spec)
                elif re.match(r"^\d+:\d+$", spec):
                    self.fail("%s: bare published port %s (bind an IP)" % (name, spec))

    def test_fluent_bit_mounts_logs_read_only_and_memory_budget(self):
        fb, _ = self.container_templates()
        blob = "\n".join(fb.values())
        for src in ("/var/lib/docker/containers", "/var/log/nginx"):
            self.assertRegex(blob, re.escape(src) + r"[^\n]*:ro", "%s must be mounted :ro" % src)
        m = re.search(r"mem_limit\s*:\s*['\"]?([0-9.]+\s*[kmgKMG]?i?[bB]?)", blob)
        self.assertIsNotNone(m)
        b = to_bytes_gib(m.group(1).replace(" ", ""))
        self.assertIsNotNone(b, m.group(1))
        self.assertLessEqual(b, 0.25 * 1024 ** 3, "Fluent Bit budget is 0.25 GiB in TRD s7.2 / LD-45")


# ------------------------------------------------------------------ scrub.lua: static checks (always run)
class ScrubStaticTest(unittest.TestCase):
    DENY = ("name", "phone", "email", "address", "dob", "birth", "password", "otp", "token", "jwt", "cookie", "secret", "signature",
            "barcode", "registration_no", "result", "value")

    def setUp(self):
        self.src = need(SCRUB)

    def test_callback_shape(self):
        self.assertRegex(self.src, r"function\s+cb_filter\s*\(\s*tag\s*,\s*timestamp\s*,\s*record\s*\)")
        self.assertRegex(self.src, r"return\s+[^\n]*,\s*timestamp\s*,\s*[^\n]+")

    def test_denylist_covers_conventions_9_2(self):
        low = self.src.lower()
        for k in self.DENY:
            self.assertRegex(low, r"['\"]%s['\"]" % re.escape(k), "denylist key %r missing from scrub.lua" % k)

    def test_value_scrubbers_present(self):
        self.assertRegex(self.src, r"(?i)bearer")
        self.assertRegex(self.src, r"eyJ")
        self.assertRegex(self.src, r"977")

    def test_query_string_defence(self):
        self.assertRegex(self.src, r"\?")
        for k in ("query", "uri", "url"):
            self.assertRegex(self.src.lower(), r"['\"]%s" % k)

    def test_no_io_or_exec_in_filter(self):  # a log filter must not touch files, processes or network
        self.assertNotRegex(self.src, r"\bio\.(open|popen)\b|\bos\.(execute|remove|rename|tmpname)\b|\bloadstring\b|\brequire\s*\(?\s*['\"](socket|lfs)")


# ------------------------------------------------------------------ scrub.lua: behaviour (needs a Lua interpreter)
def find_lua():
    for n in ("lua", "luajit", "lua5.4", "lua5.3", "lua5.1", "lua54", "lua53"):
        p = shutil.which(n)
        if p:
            return p
    return None


def lua_val(v):
    if isinstance(v, dict):
        return "{" + ",".join("[%s]=%s" % (lua_val(k), lua_val(x)) for k, x in v.items()) + "}"
    if isinstance(v, list):
        return "{" + ",".join(lua_val(x) for x in v) + "}"
    if isinstance(v, bool):
        return "true" if v else "false"
    if v is None:
        return "nil"
    if isinstance(v, (int, float)):
        return repr(v)
    s = "".join(c if c.isprintable() and c not in '"\\' and ord(c) < 128 else "".join("\\%03d" % b for b in c.encode("utf-8")) for c in v)
    return '"' + s + '"'


DRIVER = r"""
dofile(%(script)s)
local function flat(t, p, out)
  for k, v in pairs(t) do
    local kk = (p == "") and tostring(k) or (p .. "." .. tostring(k))
    if type(v) == "table" then flat(v, kk, out) else out[#out + 1] = kk .. "\t" .. (tostring(v):gsub("\n", "\\n")) end
  end
end
local rec = %(rec)s
local ok, code, ts, out = pcall(cb_filter, "t.tag", 1700000000.5, rec)
if not ok then io.write("ERR\t", tostring(code), "\n") os.exit(3) end
io.write("CODE\t", tostring(code), "\n")
if code == 0 then out = rec end
if out ~= nil then
  local o = {}
  flat(out, "", o)
  table.sort(o)
  for _, l in ipairs(o) do io.write("F\t", l, "\n") end
end
"""


def run_scrub(record):
    lua = find_lua()
    with tempfile.TemporaryDirectory() as d:
        drv = Path(d) / "drv.lua"
        drv.write_text(DRIVER % {"script": lua_val(str(SCRUB)), "rec": lua_val(record)}, encoding="utf-8")
        r = subprocess.run([lua, str(drv)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if r.returncode != 0:
        raise AssertionError("scrub.lua raised: %s %s" % (r.stdout, r.stderr))
    lines = r.stdout.splitlines()
    code = None
    fields = {}
    for ln in lines:
        parts = ln.split("\t", 2)
        if parts[0] == "CODE":
            code = int(float(parts[1])) if parts[1] not in ("nil",) else None
        elif parts[0] == "F":
            fields[parts[1]] = parts[2] if len(parts) > 2 else ""
    return code, fields


@unittest.skipUnless(find_lua(), "no lua/luajit on PATH: scrub.lua behaviour tests are NOT run here (see test_t17_live.py)")
class ScrubBehaviourTest(unittest.TestCase):
    def setUp(self):
        need(SCRUB)

    def dump(self, fields):
        return "\n".join("%s\t%s" % kv for kv in fields.items())

    def assertGone(self, fields, *needles):
        blob = self.dump(fields)
        for n in needles:
            self.assertNotIn(n, blob, "planted value %r leaked" % n)

    def test_planted_phi_denylist_keys_redacted(self):  # CV s9.2 planted-PHI log test
        rec = {"patient_name": "Sita Kumari Sharma", "full_name": "Ram Bahadur", "phone_number": "9841234567",
               "email": "sita.sharma@example.invalid", "home_address": "Ward 4 Lalitpur", "dob": "1990-01-02", "birth_date": "1990-01-02",
               "password": "hunter2-synthetic", "otp": "482913", "access_token": "tok_SYNTH_abcdef", "jwt": "eyJhbGciOiJIUzI1NiJ9.e30.sig",
               "Cookie": "sid=SYNTHSESSION", "client_secret": "s3cr3t-synthetic", "signature": "SIG-SYNTH-001", "barcode": "BC-0001-SYNTH",
               "registration_no": "REG-2083-0042", "result_text": "HIV reactive", "value": "13.4", "Result": "positive",
               "level": "info", "tenant_id": "0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d", "duration_ms": 12}
        code, f = run_scrub(rec)
        self.assertGone(f, "Sita", "Ram Bahadur", "9841234567", "sita.sharma", "Lalitpur", "1990-01-02", "hunter2", "482913", "tok_SYNTH",
                        "eyJhbGci", "SYNTHSESSION", "s3cr3t", "SIG-SYNTH", "BC-0001", "REG-2083", "HIV", "13.4", "positive")
        self.assertEqual(f.get("level"), "info")
        self.assertEqual(f.get("tenant_id"), "0a1b2c3d-4e5f-4a6b-8c7d-9e8f7a6b5c4d")
        self.assertEqual(f.get("duration_ms"), "12")
        self.assertIn(code, (1, 2), "record changed => code 1 (or 2)")

    def test_denylist_is_nested_and_case_insensitive(self):
        code, f = run_scrub({"req": {"headers": {"X-Auth-TOKEN": "SYNTH-TOK-1"}, "body": {"Patient_Name": "Gita Rai", "items": [{"phone": "+977-9812345678"}]}},
                             "msg": "ok"})
        self.assertGone(f, "SYNTH-TOK-1", "Gita Rai", "9812345678")
        self.assertEqual(f.get("msg"), "ok")

    def test_phone_numbers_scrubbed_from_free_text(self):
        for s in ("call 9841234567 now", "call +977 9841234567 now", "call +977-984-1234567 now", "call 98-41-234567 now",
                  "call (977) 9841234567 now"):
            code, f = run_scrub({"msg": s})
            blob = self.dump(f)
            self.assertIsNone(re.search(r"9841234567|984-1234567|98-41-234567|9812345678", blob), "phone survived in %r -> %r" % (s, blob))
            self.assertTrue(f.get("msg", "").startswith("call"), "surrounding text kept for %r" % s)

    def test_uuids_not_mistaken_for_phone_numbers(self):  # review T-17: CONVENTIONS s9.2 UUIDs stay intact
        uuids = ("0b1c2d3e-9123-4567-89ab-cdef01234567", "9123abcd-1234-4567-89ab-123456789012")
        for u in uuids:
            code, f = run_scrub({"request_id": u, "msg": "id " + u + " done"})
            self.assertEqual(f.get("request_id"), u, "UUID altered: %r" % f.get("request_id"))
            self.assertEqual(f.get("msg"), "id " + u + " done")
        code, f = run_scrub({"a": "call 9841234567 now", "b": "call +977-9841234567 now"})
        self.assertNotIn("9841234567", self.dump(f), "real phones must still be redacted")

    def test_bearer_and_jwt_in_values(self):
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aCJ9.c2lnbmF0dXJl"
        code, f = run_scrub({"msg": "Authorization: Bearer abc.DEF-123_xyz== failed", "note": "tok " + jwt + " end", "level": "warn"})
        self.assertGone(f, "abc.DEF-123_xyz", jwt, "eyJzdWIi")
        self.assertEqual(f.get("level"), "warn")

    def test_allowed_fields_survive_untouched(self):  # UUIDs, IPs, fiscal numbers, error codes, counts (CV s9.2 "Allowed in logs")
        rec = {"tenant_id": "0a1b2c3d-4e5f-4a6b-8c7d-984123456789", "centre_id": "11111111-2222-4333-8444-555555555555",
               "patient_id": "9a8b7c6d-1234-4abc-9def-123456789012", "invoice_no": "INV-2083-000123", "error_code": "E_DB_TIMEOUT",
               "duration_ms": 87, "count": 3, "remote_addr": "203.0.113.45", "ts": "2026-11-08T00:47:00+05:45",
               "edge_request_id": "8f14e45fceea167a5a36dedd4bea2543", "service": "api", "env": "staging", "host": "svc-host", "site": "A",
               "msg": "request completed", "level": "info"}
        code, f = run_scrub(rec)
        for k, v in rec.items():
            self.assertEqual(f.get(k), str(v), "%s altered: %r" % (k, f.get(k)))

    def test_nginx_access_line_passes_with_route_template(self):  # AC-18.4 ingest side
        rec = {"ts": "2026-11-08T00:47:00+05:45", "edge_request_id": "8f14e45fceea167a5a36dedd4bea2543", "remote_addr": "203.0.113.45",
               "host": "lims.example.invalid", "method": "GET", "route": "/r/{token}", "status": "200", "bytes": "5120", "req_time": "0.012",
               "upstream_time": "0.010", "upstream_status": "200", "ua_class": "browser", "limit_req_status": "-"}
        code, f = run_scrub(rec)
        for k, v in rec.items():
            self.assertEqual(f.get(k), v, "nginx field %s altered" % k)

    def test_query_strings_never_survive(self):  # AC-18.4 defence in depth
        for key in ("uri", "url", "path", "request_uri", "query", "query_string", "args", "URL"):
            code, f = run_scrub({key: "/v1/payments/callbacks/khalti/ABCTOK?mobile=9841234567&token=SYNTH", "msg": "x"})
            blob = self.dump(f)
            self.assertNotIn("mobile=", blob, "query string kept under key %r" % key)
            self.assertNotIn("SYNTH", blob)
            self.assertNotIn("9841234567", blob)

    def test_ops_audit_record_keeps_who_what_when(self):
        rec = {"stream": "ops_audit", "who": "oncall1", "host": "svc-host", "what": "deploy v1.2.3 to staging", "when": "2026-11-08T00:47:00Z"}
        code, f = run_scrub(rec)
        for k, v in rec.items():
            self.assertEqual(f.get(k), v, "ops_audit field %s altered" % k)

    def test_never_raises_on_odd_types_and_is_idempotent(self):
        weird = {"a": True, "b": False, "n": 3.5, "i": 7, "deep": {"x": {"y": {"z": {"w": "ok"}}}}, "empty": {}, "list": [1, "two", {"phone": "9841234567"}],
                 "big": "x" * 100000, "nl": "line1\nline2 9841234567", "utf": "सीता शर्मा visited"}
        code, f1 = run_scrub(weird)
        self.assertNotIn("9841234567", self.dump(f1))
        self.assertEqual(f1.get("deep.x.y.z.w"), "ok")
        self.assertEqual(len(f1.get("big", "")), 100000)
        code, f2 = run_scrub(weird)
        self.assertEqual(f1, f2, "deterministic")
        with self.subTest("second pass over scrubbed output is a no-op"):
            plain = {k.split(".")[0]: v for k, v in f1.items() if "." not in k}
            c2, f3 = run_scrub(plain)
            for k, v in plain.items():
                self.assertEqual(f3.get(k), v)

    def test_unchanged_record_reports_code_0(self):
        code, f = run_scrub({"msg": "all good", "level": "info", "status": "200"})
        self.assertIn(code, (0, 1, 2))
        self.assertEqual(f.get("msg"), "all good")


if __name__ == "__main__":
    unittest.main()
