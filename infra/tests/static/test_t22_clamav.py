"""T-22 tests (tester role): ClamAV service (clamd on app_net, INSTREAM, 20M limits) + signature download on ops-1 + copy to app-1.

Covers 02-TRD s7.4 (clamd paragraph, env keys), s11.3 (ScannerSignaturesStale), AC-28.1, AC-28.2, 07-SEC REQ-SEC-084, PRD B11
(freshclam only on ops via the allowlisted Squid), 06-PLAN row T-22, LD-45 (no host names/IPs in the role; lean and full both pass).
EICAR test: infra/tests/internal/eicar_probe.sh (deploy-time, from api-a) is driven here against a FAKE clamd (zINSTREAM).

CONTRACTS where the spec is silent (writer must meet them; ambiguity -> dispute, not a silent change):
 * role infra/ansible/roles/clamav: templates/clamd.conf.j2, templates/freshclam.conf.j2, files/lims-clamav-sync.sh (ops host),
   files/lims-clamav-metrics.sh (app host), tasks/main.yml, defaults/main.yml; systemd units (any file name) incl. one file that
   runs freshclam and then lims-clamav-sync (ExecStartPost / same ExecStart / OnSuccess).
 * site.yml: ONE play with hosts covering `ops` and `app`, role `clamav`, placed BEFORE the "LIMS runtime" play (clamd needs a
   populated /srv/lims/clamav-db when compose starts). Role tasks use groups['ops'] / groups['app'][0] + wg_ip, no host literals.
 * infra/compose/lims/compose.app.yml service `clamd`: image ${LIMS_CLAMD_IMAGE:?...} (digest by var, like the other images),
   networks [app_net] only, NO ports, mem_limit 3 GiB, cpus 1, env CLAMAV_NO_FRESHCLAMD=true (no route out: the image's own
   freshclam must not run), binds /srv/lims/clamav-db -> /var/lib/clamav :ro and a clamd.conf -> /etc/clamav/clamd.conf :ro,
   healthcheck `clamdscan --ping`, hardening anchor (cap_drop ALL, no-new-privileges, read_only + tmpfs, restart).
 * clamd.conf: TCPSocket 3310, TCPAddr 0.0.0.0, Foreground yes, StreamMaxLength 20M, MaxFileSize 20M, MaxScanSize 80M, LogClean no
   (each key exactly once; the last duplicate would win silently).
 * freshclam.conf: DatabaseMirror hosts == the `clamav.net` entries of egress-allowlist.yaml (via squid, :443, owner C1);
   HTTPProxyServer + HTTPProxyPort 3128; no NotifyClamd (clamd is in a container; reload is the sync script's job).
 * lims-clamav-sync.sh (runs on ops): env CLAMAV_DB_DEST + CLAMAV_RELOAD_CMD required (missing -> exit 2, no rsync);
   CLAMAV_DB_SRC default /var/lib/clamav/. Empty source (no *.cvd/*.cld/*.cud) -> exit != 0, NO rsync (never wipe the copy).
   ONE rsync (-a, src with trailing '/', DEST verbatim as ONE argument, remote dest => -e with BatchMode=yes and
   StrictHostKeyChecking=yes), then CLAMAV_RELOAD_CMD exactly once, only after rsync succeeded; rsync/reload failure -> exit != 0.
 * lims-clamav-metrics.sh (runs on app): env CLAMAV_DB_DIR (default /srv/lims/clamav-db), TEXTFILE_DIR (default
   /var/lib/node_exporter/textfile). Writes one *.prom (atomic, nothing else left behind) with
   lims_ops_scanner_signature_age_seconds = now - build time of the NEWEST of main/daily/bytecode .cvd/.cld (CVD header field 2
   `DD Mon YYYY HH-MM +ZZZZ`, or the stime field 9). No readable database -> exit != 0 and no fresh-looking value (prom removed or > 3 d).
Not provable here (marked in .orchestra/notes/C1.T-22-tests.md): a real clamd/freshclam, real Squid CONNECT to the mirror, rsync over wg0.
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip). Run: python -B -m unittest discover -s infra/tests/static -p "test_t22_*.py" -v
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
ROLE = INFRA / "ansible" / "roles" / "clamav"
COMPOSE = INFRA / "compose" / "lims" / "compose.app.yml"
ALLOW = INFRA / "edge" / "egress-allowlist.yaml"
SITE = INFRA / "ansible" / "playbooks" / "site.yml"
RULES = INFRA / "monitoring" / "rules" / "runtime.rules.yml"
PROBE = INFRA / "tests" / "internal" / "eicar_probe.sh"
SYNC = ROLE / "files" / "lims-clamav-sync.sh"
METRICS = ROLE / "files" / "lims-clamav-metrics.sh"
INVS = INFRA / "ansible" / "inventories"
METRIC = "lims_ops_scanner_signature_age_seconds"
MB = 1024 * 1024
# split so this file is not itself an antivirus hit
EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def _p(path):
    s = Path(path).as_posix()
    if os.name == "nt" and re.match(r"^[A-Za-z]:/", s):
        s = "/" + s[0].lower() + s[2:]
    return s


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def role_files():
    if not ROLE.is_dir():
        raise AssertionError("missing dir infra/ansible/roles/clamav")
    return {p.relative_to(ROLE).as_posix(): p.read_text(encoding="utf-8") for p in sorted(ROLE.rglob("*")) if p.is_file()}


def uncommented(t):
    return "\n".join(l for l in t.splitlines() if not l.strip().startswith("#"))


def render(text, **ctx):
    return jinja2.Environment(undefined=jinja2.ChainableUndefined, keep_trailing_newline=True).from_string(text).render(**ctx)


def defaults():
    return yaml.safe_load(need(ROLE / "defaults" / "main.yml")) or {}


def conf_lines(text):
    out = {}
    for l in uncommented(text).splitlines():
        l = l.strip()
        if l:
            k, _, v = l.partition(" ")
            out.setdefault(k, []).append(v.strip())
    return out


def services():
    return yaml.safe_load(need(COMPOSE))["services"]


def gib(v):
    m = re.fullmatch(r"(?:\$\{[A-Z_]+:-)?(\d+(?:\.\d+)?)([gm])\}?", str(v).strip().lower().replace("gib", "g").replace("mib", "m"))
    if not m:
        raise AssertionError("unparseable mem_limit %r" % (v,))
    return float(m.group(1)) / (1 if m.group(2) == "g" else 1024)


# ---------------------------------------------------------------- AC-28.1: clamd.conf
class ClamdConf(unittest.TestCase):
    def conf(self):
        return conf_lines(render(need(ROLE / "templates" / "clamd.conf.j2"), **defaults()))

    def test_listener_and_limits(self):  # 02-TRD s7.4 (D-209)
        c = self.conf()
        want = {"TCPSocket": "3310", "TCPAddr": "0.0.0.0", "StreamMaxLength": "20M", "MaxFileSize": "20M",
                "MaxScanSize": "80M", "LogClean": "no", "Foreground": "yes"}
        for k, v in want.items():
            self.assertEqual(c.get(k), [v], "%s must be set exactly once to %s" % (k, v))

    def test_local_socket_for_image_entrypoint(self):  # review item 1: official image entrypoint waits for this socket, else exits after CLAMD_STARTUP_TIMEOUT
        self.assertEqual(self.conf().get("LocalSocket"), ["/run/clamav/clamd.sock"])

    def test_no_unrendered_template_or_unix_socket_only(self):
        t = render(need(ROLE / "templates" / "clamd.conf.j2"), **defaults())
        self.assertNotIn("{{", t)
        self.assertNotIn("{%", t)

    def test_limits_cover_the_upload_caps(self):  # 15 MB upload cap, 16 MB attachment route; 20M > both
        c = self.conf()
        n = lambda k: int(c[k][0].rstrip("M"))
        self.assertGreaterEqual(n("StreamMaxLength"), 16)
        self.assertGreaterEqual(n("MaxScanSize"), n("MaxFileSize"))


# ---------------------------------------------------------------- compose service
class ClamdCompose(unittest.TestCase):
    def svc(self):
        s = services()
        self.assertTrue("clamd" in s, "compose.app.yml must define service `clamd`")
        return s["clamd"]

    def test_app_net_only_no_published_port(self):  # AC-28.1 "no published port", REQ-SEC-084, TRD s3.2
        s = self.svc()
        nets = s.get("networks")
        names = list(nets) if isinstance(nets, (list, dict)) else []
        self.assertEqual(names, ["app_net"], "clamd is on app_net only (never egress_net/edge_net)")
        for k in ("ports", "expose", "network_mode", "extra_hosts"):
            self.assertNotIn(k, s, "clamd must not set %s" % k)

    def test_only_squid_on_egress_net_still_true(self):
        offenders = [n for n, s in services().items() if n != "squid" and "egress_net" in (list(s.get("networks") or []))]
        self.assertEqual(offenders, [])

    def test_resources_and_hardening(self):  # TRD s7.4 row: 1 CPU, 3 GiB; LD-45 budget 3 GiB
        s = self.svc()
        self.assertEqual(gib(s["mem_limit"]), 3.0)
        self.assertEqual(float(s["cpus"]), 1.0)
        self.assertEqual(s.get("cap_drop"), ["ALL"])
        self.assertIn("no-new-privileges:true", s.get("security_opt", []))
        self.assertIs(s.get("read_only"), True)
        self.assertTrue(s.get("tmpfs"), "read_only needs a tmpfs (/tmp, /run/clamav)")
        self.assertEqual(s.get("restart"), "unless-stopped")
        self.assertRegex(str(s.get("pids_limit", "")), r"^\d+$", "pids_limit required")

    def test_image_by_variable_and_no_proxy_env(self):
        s = self.svc()
        self.assertRegex(str(s.get("image")), r"^\$\{LIMS_CLAMD_IMAGE:\?")
        env = s.get("environment") or {}
        env = env if isinstance(env, dict) else dict(e.split("=", 1) for e in env)
        self.assertEqual(str(env.get("CLAMAV_NO_FRESHCLAMD")).lower(), "true", "image freshclam must not run (no route out, ro db)")
        for k in env:
            self.assertNotRegex(k.lower(), r"proxy", "clamd gets no proxy variables")

    def test_signature_db_and_config_are_readonly_binds(self):  # TRD s7.4: /srv/lims/clamav-db ro into clamd
        vols = [str(v) for v in self.svc().get("volumes", [])]
        db = [v for v in vols if v.startswith("/srv/lims/clamav-db:") and ":/var/lib/clamav" in v]
        self.assertEqual(len(db), 1, vols)
        self.assertTrue(db[0].endswith(":ro"), "signature copy must be read-only inside clamd")
        cfg = [v for v in vols if "/etc/clamav/clamd.conf" in v]
        self.assertEqual(len(cfg), 1, vols)
        self.assertTrue(cfg[0].endswith(":ro"))
        self.assertFalse([v for v in vols if "docker.sock" in v])

    def test_healthcheck_is_clamdscan_ping(self):
        hc = self.svc().get("healthcheck") or {}
        t = " ".join(map(str, hc.get("test", [])))
        self.assertRegex(t, r"clamdscan.*--ping")
        self.assertTrue(hc.get("interval") and hc.get("retries"))

    def test_scanner_keys_on_api_and_worker(self):  # AC-28.1 (08 A25 D-209)
        s = services()
        for n in ("api-a", "api-b", "worker-a", "worker-b"):
            env = s[n]["environment"]
            self.assertEqual(env.get("LIMS_CORE_SCANNER_URL"), "tcp://clamd:3310", n)
            self.assertEqual(str(env.get("LIMS_CORE_SCANNER_TIMEOUT_MS")), "30000", n)

    def test_clamd_listener_is_not_open_on_the_edge_or_host(self):
        # AC-28.1 + nftables: the conf listens on 0.0.0.0 only inside app_net; no nftables/edge route may name 3310 as published
        for p in (INFRA / "edge" / "nginx").rglob("*"):
            if p.is_file():
                self.assertNotRegex(p.read_text(encoding="utf-8", errors="ignore"), r"clamd|:3310\b", p.name)


# ---------------------------------------------------------------- freshclam via Squid + allowlist (F-01 default, B11)
class FreshclamEgress(unittest.TestCase):
    def conf(self):
        return conf_lines(render(need(ROLE / "templates" / "freshclam.conf.j2"), **defaults()))

    def mirrors(self):
        d = yaml.safe_load(need(ALLOW))["destinations"]
        return [x for x in d if str(x["fqdn"]).lower().endswith("clamav.net")]

    def test_allowlist_has_clamav_mirror_via_squid_443_owned_by_c1(self):  # B11, 02-TRD s5.5 last bullet
        m = self.mirrors()
        self.assertTrue(m, "egress-allowlist.yaml needs the ClamAV signature mirror (clamav.net)")
        for d in m:
            self.assertEqual((d["via"], d["port"], d["owner"]), ("squid", 443, "C1"), d)
            self.assertIn(d["f01_status"], ("approved", "pending", "refused"))
            self.assertRegex(d["section_04_11"] + d["purpose"], r"(?i)clam|signature|mirror|supply")

    def test_freshclam_conf_goes_through_squid_to_allowlisted_mirror_only(self):
        c = self.conf()
        allowed = {d["fqdn"] for d in self.mirrors()}
        got = c.get("DatabaseMirror", [])
        self.assertTrue(got, "DatabaseMirror required")
        self.assertTrue(set(got) <= allowed, "mirrors %s not in allowlist %s (Squid would 403 them)" % (got, allowed))
        self.assertEqual(c.get("HTTPProxyPort"), ["3128"], "ops Squid listens on 3128 (s7.4)")
        self.assertTrue(c.get("HTTPProxyServer") and c["HTTPProxyServer"][0], "HTTPProxyServer required: no direct download")
        self.assertNotIn("NotifyClamd", c, "clamd runs in a container; the sync script reloads it")
        self.assertIn("DatabaseDirectory", c)
        self.assertNotIn("PrivateMirror", c, "no unlisted mirror")

    def test_proxy_server_is_not_a_literal_host_or_ip(self):  # LD-45: profile decides where Squid is
        raw = uncommented(need(ROLE / "templates" / "freshclam.conf.j2"))
        m = re.search(r"(?m)^HTTPProxyServer\s+(\S+)", raw)
        self.assertTrue(m)
        self.assertRegex(m.group(1), r"^\{\{.*\}\}$", "proxy address comes from a variable")


# ---------------------------------------------------------------- role wiring
class RoleWiring(unittest.TestCase):
    def test_no_host_literals_in_role(self):  # LD-45: lean and full both pass
        for name, text in role_files().items():
            t = uncommented(text)
            self.assertNotRegex(t, r"\b(prod-1|backup-1|dr-1|ops-1|app-1|data-1|dev-1)\b", name)
            self.assertNotRegex(t, r"\b10\.(77|78|79)\.\d+\.\d+\b", name)
            self.assertNotRegex(t, r"\b(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+", name)

    def test_tasks_install_scripts_confs_and_use_groups(self):
        t = need(ROLE / "tasks" / "main.yml")
        for s in ("lims-clamav-sync.sh", "lims-clamav-metrics.sh", "clamd.conf", "freshclam.conf", "/srv/lims/clamav-db", "freshclam"):
            self.assertIn(s, t, s)
        self.assertRegex(t, r"groups\[\s*'ops'\s*\]")
        self.assertRegex(t, r"groups\[\s*'app'\s*\]\[0\]")
        self.assertIn("wg_ip", t, "copy goes over wg0 to the app host's wg_ip")
        for m in re.finditer(r"(?s)(lims-clamav-(?:sync|metrics)\.sh).{0,400}?mode:\s*\"?(0\d{3})", t):
            self.assertNotIn(m.group(2)[-1], "2367", "%s mode %s is other-writable/accessible" % (m.group(1), m.group(2)))

    def test_db_dir_is_root_owned_not_world_writable(self):  # the copy is trusted by clamd: nobody else may write it
        t = need(ROLE / "tasks" / "main.yml")
        m = re.search(r"(?s)/srv/lims/clamav-db.{0,300}?mode:\s*\"?(0\d{3})", t)
        self.assertTrue(m, "clamav-db directory needs an explicit mode")
        self.assertNotIn(m.group(1)[-1], "2367")

    def test_freshclam_then_sync_in_one_unit_and_metrics_timer(self):
        files = role_files()
        both = [k for k, v in files.items() if "freshclam" in v and "lims-clamav-sync" in v and k != "tasks/main.yml"]
        self.assertTrue(both, "a unit must run freshclam and then lims-clamav-sync (ExecStartPost/ExecStart/OnSuccess)")
        self.assertTrue([k for k, v in files.items() if "lims-clamav-metrics" in v and k != "tasks/main.yml" and re.search(r"OnCalendar|OnUnitActiveSec", v)],
                        "metrics must run on a timer (stale value must not persist)")

    def test_site_yml_play_before_runtime(self):
        plays = yaml.safe_load(need(SITE))
        idx = [i for i, p in enumerate(plays) if "clamav" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertEqual(len(idx), 1, "exactly one play runs role clamav")
        hosts = str(plays[idx[0]]["hosts"])
        self.assertTrue({"ops", "app"} <= set(re.split(r"[:,]", hosts)), "play hosts must cover ops and app: %r" % hosts)
        run = [i for i, p in enumerate(plays) if p.get("name") == "LIMS runtime"]
        self.assertEqual(len(run), 1)
        self.assertLess(idx[0], run[0], "clamav before LIMS runtime (clamd needs the db dir populated)")

    def test_every_profile_has_ops_and_app_hosts_with_wg_ip(self):  # LD-45 both profiles
        for inv in ("dev", "staging", "prod", "staging-lean", "prod-lean"):
            g = yaml.safe_load(need(INVS / inv / "hosts.yml"))["all"]["children"]
            wg = {}
            for grp in g.values():
                for h, hv in ((grp or {}).get("hosts") or {}).items():
                    wg.setdefault(h, {}).update(hv or {})
            for grp in ("ops", "app"):
                self.assertTrue((g[grp] or {}).get("hosts"), "%s: group %s empty" % (inv, grp))
            self.assertIn("wg_ip", wg[next(iter(g["app"]["hosts"]))], "%s: app host needs wg_ip" % inv)


# ---------------------------------------------------------------- AC-28.2 cross-checks
class StaleAlert(unittest.TestCase):
    def test_metrics_script_emits_the_metric_the_alert_uses(self):
        rules = need(RULES)
        self.assertTrue(METRIC in rules)
        self.assertTrue(METRIC in need(METRICS), "metrics script must emit " + METRIC)
        r = [x for g in yaml.safe_load(rules)["groups"] for x in g["rules"] if x.get("alert") == "ScannerSignaturesStale"]
        self.assertEqual(len(r), 1)
        self.assertRegex(r[0]["expr"].replace(" ", ""), r"3\*86400|259200")


# ---------------------------------------------------------------- lims-clamav-metrics.sh behaviour
MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def cvd(path, age_s, junk=b"\x00" * 64):
    t = time.time() - age_s
    g = time.gmtime(t)
    hdr = "ClamAV-VDB:%02d %s %d %02d-%02d +0000:27000:2000000:90:%s:%s:builder:%d" % (
        g.tm_mday, MON[g.tm_mon - 1], g.tm_year, g.tm_hour, g.tm_min, "0" * 32, "A" * 16, int(t))
    Path(path).write_bytes(hdr.encode().ljust(512, b" ") + junk)


class MetricsScript(unittest.TestCase):
    def setUp(self):
        need(METRICS)
        self.tmp = Path(tempfile.mkdtemp(prefix="t22m-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.db = self.tmp / "db"
        self.tf = self.tmp / "tf"
        self.db.mkdir()
        self.tf.mkdir()

    def run_m(self, **extra):
        env = dict(os.environ, CLAMAV_DB_DIR=_p(self.db), TEXTFILE_DIR=_p(self.tf), **extra)
        return subprocess.run([_bash(), _p(METRICS)], env=env, capture_output=True, text=True, timeout=60)

    def age(self):
        proms = list(self.tf.iterdir())
        self.assertEqual([p.name for p in proms if not p.name.endswith(".prom")], [], "only *.prom may remain (atomic write)")
        vals = []
        for p in proms:
            for l in p.read_text().splitlines():
                m = re.fullmatch(METRIC + r"(?:\{[^}]*\})? (\d+(?:\.\d+)?)", l.strip())
                if m:
                    vals.append(float(m.group(1)))
        return vals

    def test_age_of_single_db(self):  # AC-28.2 input
        cvd(self.db / "daily.cvd", 3600)
        r = self.run_m()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        v = self.age()
        self.assertEqual(len(v), 1, v)
        self.assertAlmostEqual(v[0], 3600, delta=300)

    def test_newest_database_wins_not_oldest(self):  # 02-TRD s7.4 "newest database's build time"
        cvd(self.db / "main.cvd", 10 * 86400)
        cvd(self.db / "daily.cld", 7200)
        cvd(self.db / "bytecode.cvd", 5 * 86400)
        self.assertEqual(self.run_m().returncode, 0)
        v = self.age()
        self.assertEqual(len(v), 1)
        self.assertAlmostEqual(v[0], 7200, delta=300)

    def test_stale_value_crosses_the_alert_threshold(self):  # AC-28.2 (> 3 days)
        cvd(self.db / "daily.cvd", 3 * 86400 + 3600)
        self.assertEqual(self.run_m().returncode, 0)
        self.assertGreater(self.age()[0], 3 * 86400)

    def test_prom_has_type_gauge_if_help_type_present(self):
        cvd(self.db / "daily.cvd", 60)
        self.run_m()
        txt = "".join(p.read_text() for p in self.tf.iterdir())
        for l in txt.splitlines():
            if l.startswith("# TYPE " + METRIC):
                self.assertTrue(l.endswith(" gauge"))

    def test_no_database_means_failure_and_no_fresh_looking_value(self):  # missing metric must not hide staleness
        r = self.run_m()
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(all(x > 3 * 86400 for x in self.age()))

    def test_garbage_header_is_not_trusted(self):  # a corrupt/forged file must not read as fresh
        (self.db / "daily.cvd").write_bytes(b"not a clamav database " * 40)
        r = self.run_m()
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(all(x > 3 * 86400 for x in self.age()))

    def test_failed_run_removes_a_previous_fresh_value(self):  # never leave yesterday's "fresh" behind
        cvd(self.db / "daily.cvd", 60)
        self.assertEqual(self.run_m().returncode, 0)
        (self.db / "daily.cvd").unlink()
        self.assertNotEqual(self.run_m().returncode, 0)
        self.assertTrue(all(x > 3 * 86400 for x in self.age()))

    def test_future_build_time_is_not_negative(self):  # clock skew / forged header
        cvd(self.db / "daily.cvd", -86400)
        r = self.run_m()
        if r.returncode == 0:
            self.assertTrue(all(x >= 0 for x in self.age()))


# ---------------------------------------------------------------- lims-clamav-sync.sh behaviour (fake rsync)
FAKE_RSYNC = """#!/usr/bin/env bash
{ echo CALL; for a in "$@"; do echo "ARG:$a"; done; } >> "$FIX/calls.log"
exit ${FAKE_RSYNC_RC:-0}
"""


class SyncScript(unittest.TestCase):
    DEST = "lims-clamav@10.0.0.9:/srv/lims/clamav-db/"

    def setUp(self):
        need(SYNC)
        self.tmp = Path(tempfile.mkdtemp(prefix="t22s-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.src = self.tmp / "src"
        self.bin.mkdir()
        self.src.mkdir()
        (self.bin / "rsync").write_bytes(FAKE_RSYNC.encode())
        cvd(self.src / "daily.cvd", 60)
        cvd(self.src / "main.cvd", 86400)

    def run_s(self, env_over=None, drop=(), rsync_rc=0, reload_rc=0):
        env = dict(os.environ, FIX=_p(self.tmp), FAKE_RSYNC_RC=str(rsync_rc), CLAMAV_DB_SRC=_p(self.src) + "/",
                   CLAMAV_DB_DEST=self.DEST,
                   CLAMAV_RELOAD_CMD='echo RELOAD >> "$FIX/calls.log"; exit %d' % reload_rc,
                   PATH=_p(self.bin) + os.pathsep + os.environ["PATH"])
        env.update(env_over or {})
        for k in drop:
            env.pop(k, None)
        (self.tmp / "calls.log").unlink(missing_ok=True)
        r = subprocess.run([_bash(), _p(SYNC)], env=env, capture_output=True, text=True, timeout=60)
        log = (self.tmp / "calls.log").read_text() if (self.tmp / "calls.log").exists() else ""
        return r, log

    @staticmethod
    def calls(log):
        out, cur = [], None
        for l in log.splitlines():
            if l == "CALL":
                cur = []
                out.append(cur)
            elif l.startswith("ARG:"):
                cur.append(l[4:])
        return out

    def test_one_rsync_then_one_reload_in_order(self):  # TRD s7.4: copy, then RELOAD
        r, log = self.run_s()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(self.calls(log)), 1, log)
        self.assertEqual(log.count("RELOAD"), 1)
        self.assertLess(log.index("CALL"), log.index("RELOAD"), "reload only after the copy")

    def test_rsync_args(self):
        _, log = self.run_s()
        a = self.calls(log)[0]
        self.assertTrue(any(x in ("-a", "--archive") or re.fullmatch(r"-[a-zA-Z]*a[a-zA-Z]*", x) for x in a), a)
        self.assertIn(self.DEST, a, "DEST passed verbatim as ONE argument")
        self.assertEqual(a[-1], self.DEST)
        self.assertEqual(a[-2], _p(self.src) + "/", "source with trailing slash = directory contents")
        self.assertNotIn("--remove-source-files", a)

    def test_remote_dest_uses_strict_batch_ssh(self):  # over wg0, pinned host, never interactive
        _, log = self.run_s()
        a = self.calls(log)[0]
        e = [a[i + 1] for i, x in enumerate(a) if x == "-e"] + [x[len("--rsh="):] for x in a if x.startswith("--rsh=")]
        self.assertEqual(len(e), 1, a)
        self.assertIn("BatchMode=yes", e[0])
        self.assertIn("StrictHostKeyChecking=yes", e[0])

    def test_rsync_failure_no_reload_and_nonzero(self):
        r, log = self.run_s(rsync_rc=23)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("RELOAD", log)

    def test_reload_failure_is_not_success(self):
        r, log = self.run_s(reload_rc=1)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(log.count("RELOAD"), 1)

    def test_empty_source_never_syncs(self):  # a failed freshclam must not wipe the app copy
        for f in self.src.iterdir():
            f.unlink()
        r, log = self.run_s()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.calls(log), [], "rsync must not run with an empty source")
        self.assertNotIn("RELOAD", log)

    def test_source_with_only_non_database_files_never_syncs(self):
        for f in self.src.iterdir():
            f.unlink()
        (self.src / "freshclam.dat").write_text("x")
        r, log = self.run_s()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.calls(log), [])

    def test_missing_config_is_usage_error_without_side_effects(self):
        for k in ("CLAMAV_DB_DEST", "CLAMAV_RELOAD_CMD"):
            with self.subTest(missing=k):
                r, log = self.run_s(drop=(k,))
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertEqual(log, "")

    def test_dest_with_shell_metacharacters_stays_one_argument(self):
        evil = "u@10.0.0.9:/srv/lims/clamav-db/; touch %s/pwned #" % _p(self.tmp)
        r, log = self.run_s({"CLAMAV_DB_DEST": evil})
        self.assertFalse((self.tmp / "pwned").exists(), "DEST was interpreted by a shell")
        if self.calls(log):
            self.assertEqual(self.calls(log)[0][-1], evil)


# ---------------------------------------------------------------- EICAR probe vs a FAKE clamd
class FakeClamd(threading.Thread):
    def __init__(self, detect=True, enforce=True, limit=20 * MB):
        super().__init__(daemon=True)
        self.detect, self.enforce, self.limit = detect, enforce, limit
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(8)
        self.port = self.srv.getsockname()[1]
        self.stop = False
        self.hits = 0

    def run(self):
        while not self.stop:
            try:
                c, _ = self.srv.accept()
            except OSError:
                return
            self.hits += 1
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    @staticmethod
    def rd(c, n):
        b = b""
        while len(b) < n:
            d = c.recv(n - len(b))
            if not d:
                raise EOFError
            b += d
        return b

    def serve(self, c):
        try:
            cmd = b""
            while not cmd.endswith(b"\0"):
                cmd += self.rd(c, 1)
            if cmd == b"zPING\0":
                c.sendall(b"PONG\0")
            elif cmd == b"zINSTREAM\0":
                data, total = b"", 0
                while True:
                    n = int.from_bytes(self.rd(c, 4), "big")
                    if n == 0:
                        break
                    chunk = self.rd(c, n)
                    total += n
                    if self.enforce and total > self.limit:
                        c.sendall(b"INSTREAM size limit exceeded. ERROR\0")
                        c.settimeout(3)
                        try:
                            while c.recv(65536):
                                pass
                        except OSError:
                            pass
                        return
                    if len(data) < 4096:
                        data += chunk
                hit = self.detect and EICAR.encode() in data
                c.sendall(b"stream: Win.Test.EICAR_HDB-1 FOUND\0" if hit else b"stream: OK\0")
        except (EOFError, OSError):
            pass
        finally:
            c.close()


FAKE_DOCKER = """#!/usr/bin/env bash
case "$1" in
  inspect) echo "${FAKE_RUNNING:-true}"; exit 0 ;;
  exec)
    shift
    while [ $# -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
    shift  # container name
    if [ "${FAKE_NO_NODE:-}" = 1 ] && [ "$1" = sh ]; then exit 1; fi
    exec "$@" ;;
esac
exit 1
"""


class EicarProbe(unittest.TestCase):
    def setUp(self):
        need(PROBE)
        self.tmp = Path(tempfile.mkdtemp(prefix="t22p-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        (self.tmp / "docker").write_bytes(FAKE_DOCKER.encode())
        if not shutil.which("node"):
            raise AssertionError("node must be installed to run the probe harness")

    def clamd(self, **kw):
        d = FakeClamd(**kw)
        d.start()
        self.addCleanup(lambda: (setattr(d, "stop", True), d.srv.close()))
        return d

    def run_p(self, port, *args, **env):
        e = dict(os.environ, PATH=_p(self.tmp) + os.pathsep + os.environ["PATH"], CLAMD_ADDR="127.0.0.1:%d" % port, **env)
        return subprocess.run([_bash(), _p(PROBE), *(args or ("api-a",))], env=e, capture_output=True, text=True, timeout=120)

    def test_working_clamd_passes_all_four_checks(self):  # AC-28.1
        d = self.clamd()
        r = self.run_p(d.port)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(len(re.findall(r"(?m)^ok \d+", r.stdout)), len(re.findall(r"(?m)^(?:ok|not ok) \d+", r.stdout)))
        self.assertRegex(r.stdout, r"FOUND")
        self.assertIn("1..", r.stdout)

    def test_scanner_that_misses_eicar_fails(self):  # negative control: the probe can fail
        r = self.run_p(self.clamd(detect=False).port)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r"(?m)^not ok .*EICAR")

    def test_scanner_without_stream_limit_fails(self):  # StreamMaxLength must really be applied
        r = self.run_p(self.clamd(enforce=False).port)
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stdout, r"(?m)^not ok .*refused")

    def test_unreachable_clamd_fails_closed(self):
        s = socket.socket()
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
        s.close()
        r = self.run_p(port)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotRegex(r.stdout, r"(?m)^ok .*(FOUND|PING|OK)")

    def test_stopped_container_fails_without_touching_clamd(self):
        d = self.clamd()
        r = self.run_p(d.port, FAKE_RUNNING="false")
        self.assertEqual(r.returncode, 1)
        self.assertEqual(d.hits, 0)

    def test_missing_node_in_container_fails_closed(self):
        d = self.clamd()
        r = self.run_p(d.port, FAKE_NO_NODE="1")
        self.assertNotEqual(r.returncode, 0)

    def test_usage_errors(self):
        d = self.clamd()
        e = dict(os.environ, PATH=_p(self.tmp) + os.pathsep + os.environ["PATH"])
        r = subprocess.run([_bash(), _p(PROBE)], env=e, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)
        e["CLAMD_ADDR"] = "no-port"
        r = subprocess.run([_bash(), _p(PROBE), "api-a"], env=e, capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 2)

    def test_probe_file_is_not_itself_an_eicar_hit(self):
        for t in (need(PROBE), Path(__file__).read_text(encoding="utf-8")):
            self.assertNotIn(EICAR, t.replace("\\\\", "\\"))


if __name__ == "__main__":
    unittest.main()
