"""T-05 tests (tester role): Supabase compose layering, two hosts. Covers 02-TRD s7.1/s7.2/s3.2/s3.3/s5.5,
AC-01.3, AC-06.2, AC-26.2, AC-09.3 (auth part), 07-SEC rows "published ports", "egress_probe", "UPSTREAM.lock".

CONTRACTS the writer must meet (tester's reading of the TRD where it is silent):
 * Run layout: project dir = infra/compose/supabase, project name `supabase`, files exactly as TRD s7.2:
     data-1: upstream/docker-compose.yml + upstream/docker-compose.pgbouncer.yml + override.data.yml  (up: db pgbouncer)
     app-1 : upstream/docker-compose.yml + override.app.yml  (up: api-gw auth rest storage imgproxy)
   The services `up` names plus their depends_on closure must be exactly that set (nothing else gets started).
 * Env for `config`: upstream/.env.example + WG_IP + POSTGRES_HOST (=data-1 wg IP) + SMTP_HOST/SMTP_PORT=587;
   remaining unset vars are filled with dummies, so overrides must take hosts/IPs from env, not hardcode them.
 * DECISION.md has a line `Decision: split` or `Decision: fallback`. `fallback` = TRD s7.2 fallback (all seven
   services on data-1 via override.data.yml, gateway on ${WG_IP}:8000); split-only checks are then not run.
 * UPSTREAM.lock is YAML: repo, commit (40 hex), fetched (YYYY-MM-DD), files: {<path relative to upstream/>: sha256},
   images: {<service>: {image, tag, digest: sha256:..}} for api-gw auth rest storage imgproxy pgbouncer.
   `files` = every file under upstream/ except UPSTREAM.lock itself, byte-exact. .gitattributes must stop EOL conversion.
 * Rendered `image:` of those services (override files) = <image>@<lock digest> (equality = "single digest source").
   db image = registry.lims.internal/lims/postgres-pgbackrest@sha256:<64hex> (derived image, T-04, not in lock).
 * api-gw mounts a TRIMMED lds file from OUTSIDE upstream/ (upstream stays byte-for-byte) without functions/studio/meta/realtime.
Needs the docker CLI (compose >= 2.24.4) for `config`; no daemon. Missing docker/file = FAIL, never skip.
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t05_*.py" -v
"""
import datetime
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


class _ComposeLoader(yaml.SafeLoader):
    """LD-42: vendored upstream compose files use !reset/!override; pass the plain value through."""


def _passthrough(loader, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node) if node.value not in ("", "null", "~") else None
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_mapping(node, deep=True)


_ComposeLoader.add_constructor("!reset", _passthrough)
_ComposeLoader.add_constructor("!override", _passthrough)


def _load_compose(path):
    return yaml.load(Path(path).read_text(encoding="utf-8"), Loader=_ComposeLoader)


ROOT =Path(__file__).resolve().parents[3]
SUPA = ROOT / "infra" / "compose" / "supabase"
UP = SUPA / "upstream"
LOCK = UP / "UPSTREAM.lock"
DECISION = SUPA / "DECISION.md"
PUBLISHED = ROOT / "infra" / "tests" / "internal" / "published_ports.py"
PROBE = ROOT / "infra" / "tests" / "internal" / "egress_probe.sh"

DATA_WG, APP_WG, RELAY = "10.79.0.11", "10.79.0.12", "smtp-relay.example.test"
APP_SET = {"api-gw", "auth", "rest", "storage", "imgproxy"}
DATA_SET = {"db", "pgbouncer"}
LOCK_IMAGES = APP_SET | {"pgbouncer"}
REQUIRED_UPSTREAM = ["docker-compose.yml", "docker-compose.pgbouncer.yml", ".env.example",
                     "volumes/api/envoy/lds.template.yaml"]
LAYERS = {
    "data-1": (["upstream/docker-compose.yml", "upstream/docker-compose.pgbouncer.yml", "override.data.yml"], DATA_WG),
    "app-1": (["upstream/docker-compose.yml", "override.app.yml"], APP_WG),
}
SHA = re.compile(r"^[0-9a-f]{64}$")


def bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", "/usr/bin/bash"):
        if os.path.exists(c):
            return c
    return shutil.which("bash")


def decision():
    if not DECISION.is_file():
        raise AssertionError("missing file infra/compose/supabase/DECISION.md")
    m = re.search(r"(?mi)^\W*Decision\W*:\W*(split|fallback)\b", DECISION.read_text(encoding="utf-8"))
    if not m:
        raise AssertionError("DECISION.md needs a line 'Decision: split' or 'Decision: fallback'")
    return m.group(1).lower()


# ---------------------------------------------------------------- UPSTREAM.lock checker (CI "UPSTREAM.lock check")
def sha256(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def verify_lock(up):
    """Return list of problems: lock vs the real bytes under `up`. Empty list = intact."""
    up = Path(up)
    lock = up / "UPSTREAM.lock"
    if not lock.is_file():
        return ["missing UPSTREAM.lock"]
    try:
        data = yaml.safe_load(lock.read_text(encoding="utf-8"))
        files = data["files"]
        assert isinstance(files, dict) and files
    except Exception as e:
        return ["unreadable lock / no files map: %s" % e]
    probs = []
    for rel, digest in files.items():
        parts = Path(str(rel)).parts
        if os.path.isabs(str(rel)) or ".." in parts or "\\" in str(rel):
            probs.append("unsafe path in lock: %s" % rel)
            continue
        f = up / rel
        if not f.is_file():
            probs.append("listed but missing: %s" % rel)
        elif not SHA.match(str(digest)) or sha256(f) != digest:
            probs.append("sha256 differs: %s" % rel)
    actual = {p.relative_to(up).as_posix() for p in up.rglob("*") if p.is_file() and p.name != "UPSTREAM.lock"}
    for extra in sorted(actual - set(files)):
        probs.append("not in lock: %s" % extra)
    return probs


# ---------------------------------------------------------------- compose helpers
def docker_ok():
    try:
        r = subprocess.run(["docker", "compose", "version", "--short"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise AssertionError("docker CLI required for compose config: %s" % e)
    if r.returncode:
        raise AssertionError("docker compose unavailable: %s" % r.stderr)
    v = tuple(int(x) for x in re.findall(r"\d+", r.stdout.strip().lstrip("v"))[:3])
    if v < (2, 24, 4):
        raise AssertionError("compose %s too old for !reset/!override (need >= 2.24.4)" % r.stdout.strip())


def env_for(wg_ip, files):
    env = {}
    ex = UP / ".env.example"
    if ex.is_file():
        for line in ex.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                env[m.group(1)] = m.group(2)
    env.update({"WG_IP": wg_ip, "POSTGRES_HOST": DATA_WG, "SMTP_HOST": RELAY, "SMTP_PORT": "587"})
    for rel in files:  # fill required-without-default vars with dummies so only structural errors surface
        for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^}]*)?\}", (SUPA / rel).read_text(encoding="utf-8")):
            env.setdefault(m.group(1), "8000" if m.group(1).endswith("PORT") else "x")
    return env


def compose_config(host):
    docker_ok()
    files, wg = LAYERS[host]
    for f in files:
        if not (SUPA / f).is_file():
            raise AssertionError("missing file infra/compose/supabase/%s" % f)
    with tempfile.TemporaryDirectory() as td:
        ef = Path(td) / "env"
        ef.write_text("".join("%s=%s\n" % kv for kv in env_for(wg, files).items()), encoding="utf-8")
        cmd = ["docker", "compose", "--project-directory", str(SUPA), "-p", "supabase", "--env-file", str(ef)]
        for f in files:
            cmd += ["-f", str(SUPA / f)]
        r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise AssertionError("docker compose config failed on %s:\n%s" % (host, r.stderr.strip()[-1500:]))
    return json.loads(r.stdout)


def closure(cfg, names):
    seen, todo = set(), list(names)
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        if n not in cfg["services"]:
            raise AssertionError("service %s not defined (depends_on of a removed service?)" % n)
        seen.add(n)
        todo += list((cfg["services"][n].get("depends_on") or {}).keys())
    return seen


_cache = {}


def cfg_of(host):
    if host not in _cache:
        _cache[host] = compose_config(host)
    return _cache[host]


def nets(svc):
    return set((svc.get("networks") or {}).keys())


def lock():
    if not LOCK.is_file():
        raise AssertionError("missing file infra/compose/supabase/upstream/UPSTREAM.lock")
    return yaml.safe_load(LOCK.read_text(encoding="utf-8"))


# ================================================================ 1. tools proven on synthetic input (pass now)
class PublishedPortsToolTest(unittest.TestCase):
    def run_tool(self, cfg, *extra):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "c.json"
            p.write_text(json.dumps(cfg), encoding="utf-8")
            return subprocess.run([sys.executable, "-B", str(PUBLISHED), "--wg-ip", DATA_WG, *extra, str(p)],
                                  capture_output=True, text=True)

    def svc(self, **ports):
        return {"services": {"x": {"ports": ports["ports"]}}}

    def test_tool_exists(self):
        self.assertTrue(PUBLISHED.is_file(), "missing infra/tests/internal/published_ports.py")

    def test_ok_cases(self):
        for ports in ([{"host_ip": "127.0.0.1", "published": "8000", "target": 8000}],
                      [{"host_ip": DATA_WG, "published": "5432", "target": 5432}], ["10.79.0.11:6432:6432"], []):
            r = self.run_tool(self.svc(ports=ports))
            self.assertEqual(r.returncode, 0, (ports, r.stdout, r.stderr))

    def test_violations(self):
        bad = ([{"published": "8000", "target": 8000}], [{"host_ip": "0.0.0.0", "published": "80", "target": 80}],
               [{"host_ip": "::", "published": "80", "target": 80}], ["8000:8000"], ["80"],
               [{"target": 80, "protocol": "tcp"}], [{"host_ip": "10.79.0.99", "published": "80", "target": 80}],
               [{"host_ip": "203.0.113.9", "published": "80", "target": 80}])  # public ip only for nginx
        for ports in bad:
            r = self.run_tool(self.svc(ports=ports), "--public-ip", "203.0.113.9")
            self.assertEqual(r.returncode, 1, (ports, r.stdout))
            self.assertIn("VIOLATION", r.stdout)

    def test_network_mode_host_is_violation(self):
        self.assertEqual(self.run_tool({"services": {"x": {"network_mode": "host"}}}).returncode, 1)

    def test_nginx_public_exception_is_narrow(self):
        ok = {"services": {"nginx": {"ports": [{"host_ip": "203.0.113.9", "published": "443", "target": 443},
                                               {"host_ip": "203.0.113.9", "published": "80", "target": 80}]}}}
        self.assertEqual(self.run_tool(ok, "--public-ip", "203.0.113.9").returncode, 0)
        for pub, name in (("8443", "nginx"), ("443", "web"), ("22", "nginx")):
            cfg = {"services": {name: {"ports": [{"host_ip": "203.0.113.9", "published": pub, "target": 443}]}}}
            self.assertEqual(self.run_tool(cfg, "--public-ip", "203.0.113.9").returncode, 1, (pub, name))
        self.assertEqual(self.run_tool(ok).returncode, 1, "without --public-ip there is no exception")

    def test_unreadable_input_is_not_a_pass(self):
        r = subprocess.run([sys.executable, "-B", str(PUBLISHED), "--wg-ip", DATA_WG, "no-such-file.json"],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "empty.json"
            p.write_text("{}", encoding="utf-8")
            r = subprocess.run([sys.executable, "-B", str(PUBLISHED), "--wg-ip", DATA_WG, str(p)],
                               capture_output=True, text=True)
        self.assertEqual(r.returncode, 2, "config without services must not look like 'no published ports'")

    def test_only_filters_services(self):
        cfg = {"services": {"ok": {}, "analytics": {"ports": ["4000:4000"]}}}
        self.assertEqual(self.run_tool(cfg).returncode, 1)
        self.assertEqual(self.run_tool(cfg, "--only", "ok").returncode, 0)


class EgressProbeToolTest(unittest.TestCase):
    """egress_probe.sh auth driven by a fake `docker` on PATH (pure logic; the real run is deploy/CI)."""
    ALLOW = [DATA_WG + ":5432", RELAY + ":587"]

    def run_probe(self, allow, **extra):
        b = bash()
        self.assertTrue(b, "bash required")
        with tempfile.TemporaryDirectory() as td:
            shim = Path(td) / "docker"
            shim.write_text(
                '#!/usr/bin/env bash\n'
                'case "$1" in\n'
                '  inspect) [ -n "$SHIM_STOPPED" ] && echo false || echo true; exit 0;;\n'
                '  exec) shift; shift\n'
                '     if [ "$1" = sh ]; then [ -n "$SHIM_NO_NC" ] && exit 1 || exit 0; fi\n'
                '     [ -n "$SHIM_STOPPED" ] && exit 1\n'
                '     h=${@: -2:1}; p=${@: -1}\n'
                '     for a in $SHIM_ALLOW; do [ "$a" = "$h:$p" ] && exit 0; done; exit 1;;\n'
                'esac\nexit 1\n', encoding="utf-8", newline="\n")
            env = dict(os.environ, PATH=td + os.pathsep + os.environ["PATH"], SHIM_ALLOW=" ".join(allow),
                       DATA_WG_IP=DATA_WG, SMTP_RELAY_HOST=RELAY, **extra)
            return subprocess.run([b, str(PROBE), "auth"], capture_output=True, text=True, env=env, timeout=60)

    def test_script_exists_and_parses(self):
        self.assertTrue(PROBE.is_file(), "missing infra/tests/internal/egress_probe.sh")
        r = subprocess.run([bash(), "-n", str(PROBE)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_correct_firewall_passes(self):
        r = self.run_probe(self.ALLOW)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("ok ", r.stdout)
        self.assertNotIn("not ok", r.stdout)

    def test_each_leak_is_caught(self):
        for leak in ("1.1.1.1:443", RELAY + ":25", RELAY + ":465", DATA_WG + ":22", "169.254.169.254:80"):
            r = self.run_probe(self.ALLOW + [leak])
            self.assertEqual(r.returncode, 1, "leak %s not detected:\n%s" % (leak, r.stdout))
            self.assertIn("not ok", r.stdout)

    def test_blocked_legit_path_is_caught(self):
        for missing in self.ALLOW:
            r = self.run_probe([a for a in self.ALLOW if a != missing])
            self.assertEqual(r.returncode, 1, "broken path %s not detected" % missing)

    def test_cannot_pass_vacuously(self):  # stopped container / no nc would make every deny probe 'succeed'
        self.assertEqual(self.run_probe(self.ALLOW, SHIM_STOPPED="1").returncode, 1)
        self.assertEqual(self.run_probe(self.ALLOW, SHIM_NO_NC="1").returncode, 1)

    def test_usage_errors(self):
        b = bash()
        env = {k: v for k, v in os.environ.items() if k not in ("DATA_WG_IP", "SMTP_RELAY_HOST")}
        for args in ([], ["auth"]):
            r = subprocess.run([b, str(PROBE), *args], capture_output=True, text=True, env=env)
            self.assertEqual(r.returncode, 2, args)


class LockCheckerSelfTest(unittest.TestCase):
    """verify_lock() must catch tampering - proven on a synthetic tree so it cannot hide behind a missing lock."""

    def make(self, td):
        up = Path(td) / "upstream"
        (up / "volumes").mkdir(parents=True)
        (up / "a.yml").write_bytes(b"a: 1\n")
        (up / "volumes" / "b.yaml").write_bytes(b"b: 2\n")
        files = {"a.yml": sha256(up / "a.yml"), "volumes/b.yaml": sha256(up / "volumes/b.yaml")}
        (up / "UPSTREAM.lock").write_text(yaml.safe_dump({"files": files}), encoding="utf-8")
        return up

    def test_intact(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(verify_lock(self.make(td)), [])

    def test_modified_byte_extra_missing_traversal(self):
        with tempfile.TemporaryDirectory() as td:
            up = self.make(td)
            (up / "a.yml").write_bytes(b"a: 1\r\n")  # EOL conversion is a modification
            self.assertTrue(any("differs" in p for p in verify_lock(up)))
            (up / "a.yml").write_bytes(b"a: 1\n")
            (up / "extra.yml").write_bytes(b"x")
            self.assertTrue(any("not in lock" in p for p in verify_lock(up)))
            (up / "extra.yml").unlink()
            (up / "volumes" / "b.yaml").unlink()
            self.assertTrue(any("missing" in p for p in verify_lock(up)))
            (up / "UPSTREAM.lock").write_text(yaml.safe_dump({"files": {"../../etc/passwd": "0" * 64}}), encoding="utf-8")
            self.assertTrue(any("unsafe" in p for p in verify_lock(up)))


# ================================================================ 2. UPSTREAM.lock on the real tree (fail now)
class UpstreamLockTest(unittest.TestCase):
    def test_required_upstream_files_present(self):
        for rel in REQUIRED_UPSTREAM:
            self.assertTrue((UP / rel).is_file(), "missing file infra/compose/supabase/upstream/%s" % rel)

    def test_lock_metadata(self):
        d = lock()
        self.assertEqual(d.get("repo"), "https://github.com/supabase/supabase")
        self.assertRegex(str(d.get("commit")), r"^[0-9a-f]{40}$")
        day = datetime.date.fromisoformat(str(d.get("fetched")))
        self.assertLessEqual(day, datetime.date.today(), "fetch date in the future")

    def test_lock_matches_bytes_on_disk(self):
        self.assertEqual(verify_lock(UP), [], "UPSTREAM.lock integrity (modified / extra / missing file)")

    def test_lock_covers_required_files(self):
        files = lock().get("files") or {}
        for rel in REQUIRED_UPSTREAM:
            self.assertIn(rel, files)

    def test_no_eol_conversion(self):  # Windows autocrlf would silently break every sha256
        r = subprocess.run(["git", "check-attr", "text", "eol", "--", "infra/compose/supabase/upstream/docker-compose.yml"],
                           cwd=ROOT, capture_output=True, text=True)
        self.assertIn("text: unset", r.stdout, ".gitattributes must set `-text` for infra/compose/supabase/upstream/**: " + r.stdout)

    def test_image_digests_recorded(self):
        imgs = lock().get("images") or {}
        for s in sorted(LOCK_IMAGES):
            self.assertIn(s, imgs, "lock has no image digest for %s" % s)
            e = imgs[s]
            self.assertTrue(e.get("image") and e.get("tag"), s)
            self.assertRegex(str(e.get("digest")), r"^sha256:[0-9a-f]{64}$", s)

    def test_lock_images_match_upstream_compose_tags(self):
        for rel in REQUIRED_UPSTREAM[:2]:
            self.assertTrue((UP / rel).is_file(), "missing file infra/compose/supabase/upstream/%s" % rel)
        base = _load_compose(UP / "docker-compose.yml")["services"]
        pgb = _load_compose(UP / "docker-compose.pgbouncer.yml")["services"]
        imgs = lock()["images"]
        for s in sorted(LOCK_IMAGES):
            raw = (pgb.get(s) or base.get(s) or {}).get("image")
            self.assertTrue(raw, "service %s not in upstream compose files" % s)
            self.assertEqual(raw, "%s:%s" % (imgs[s]["image"], imgs[s]["tag"]), "lock out of step with the snapshot for " + s)

    def test_rendered_images_use_lock_digest(self):  # the equality C0's check also enforces (D-208)
        imgs = lock()["images"]
        for host, names in (("app-1", APP_SET), ("data-1", {"pgbouncer"})):
            for s in sorted(names):
                self.assertEqual(cfg_of(host)["services"][s]["image"], "%s@%s" % (imgs[s]["image"], imgs[s]["digest"]),
                                 "%s on %s must be pinned to the lock digest" % (s, host))

    def test_devstack_digests_equal_lock_when_present(self):  # C0 owns the file; absent until C0 lands
        ds = ROOT / "tools" / "devstack" / "compose.yaml"
        if not ds.is_file():
            return
        text = ds.read_text(encoding="utf-8")
        for s, e in lock()["images"].items():
            if e["image"] in text:
                self.assertIn(e["digest"], text, "devstack digest for %s differs from UPSTREAM.lock" % s)


# ================================================================ 3. DECISION.md
class DecisionTest(unittest.TestCase):
    def test_decision_recorded_with_spike_evidence(self):
        mode = decision()
        text = DECISION.read_text(encoding="utf-8")
        for needle in ("!reset", "depends_on", "functions", "Compose"):
            self.assertIn(needle, text, "DECISION.md must record spike result for: " + needle)
        self.assertRegex(text, r"\d+\.\d+\.\d+", "record the Compose version used in the spike")
        if mode == "fallback":
            self.assertIn("8000", text)
            self.assertRegex(text, r"(?i)why|because|failed")


# ================================================================ 4. layering, both hosts
class ComposeLayeringTest(unittest.TestCase):
    def test_config_valid_both_hosts(self):
        for host in LAYERS:
            self.assertIn("services", cfg_of(host))

    def test_data_host_starts_only_db_and_pgbouncer(self):
        got = closure(cfg_of("data-1"), DATA_SET)
        self.assertEqual(got, DATA_SET, "extra services pulled in by depends_on: %s" % sorted(got - DATA_SET))
        self.assertNotIn("supavisor", cfg_of("data-1")["services"])

    def test_app_host_starts_exactly_gateway_auth_rest_storage_imgproxy(self):
        if decision() == "fallback":
            self.skipTest("Decision: fallback - app-1 runs no Supabase project")
        c = cfg_of("app-1")
        got = closure(c, APP_SET)
        self.assertEqual(got, APP_SET, "app-1 would also start: %s" % sorted(got - APP_SET))
        for gone in ("db", "supavisor", "studio", "meta", "functions", "realtime"):
            self.assertNotIn(gone, c["services"], "%s must be removed on app-1 (!reset null)" % gone)

    def test_networks_per_service_ac_26_2(self):  # AC-26.2, TRD s3.2
        if decision() == "fallback":
            self.skipTest("Decision: fallback")
        s = cfg_of("app-1")["services"]
        want = {"api-gw": {"app_net", "auth_net"}, "auth": {"auth_net", "db_net"}, "rest": {"app_net", "db_net"},
                "storage": {"app_net", "db_net"}, "imgproxy": {"app_net"}}
        for name, n in want.items():
            self.assertEqual(nets(s[name]), n, "%s networks" % name)
        for name in APP_SET:  # never on edge_net / render_net / default
            self.assertFalse(nets(s[name]) & {"edge_net", "render_net", "egress_net", "default"}, name)

    def test_network_definitions(self):
        if decision() == "fallback":
            self.skipTest("Decision: fallback")
        n = cfg_of("app-1")["networks"]
        for name, subnet, internal in (("app_net", "172.30.20.0/24", True), ("auth_net", "172.30.30.0/24", True),
                                       ("db_net", "172.30.50.0/24", False)):
            self.assertIn(name, n)
            self.assertEqual(bool(n[name].get("internal")), internal, name)
            self.assertEqual([c["subnet"] for c in n[name]["ipam"]["config"]], [subnet], name)

    def test_gotrue_fixed_db_net_address_and_no_port(self):  # nftables SMTP exception matches the source IP
        if decision() == "fallback":
            self.skipTest("Decision: fallback")
        a = cfg_of("app-1")["services"]["auth"]
        self.assertEqual(a["networks"]["db_net"]["ipv4_address"], "172.30.50.20")
        self.assertFalse(a.get("ports"), "GoTrue must publish nothing")

    def test_gotrue_reaches_data_host_and_smtp_relay_by_env(self):  # done_when: reaches data-1 and relay over db_net
        env = cfg_of("app-1")["services"]["auth"]["environment"]
        self.assertIn("@%s:" % DATA_WG, env["GOTRUE_DB_DATABASE_URL"], "DB host must follow POSTGRES_HOST (data-1 wg IP)")
        self.assertEqual(env["GOTRUE_SMTP_HOST"], RELAY)
        self.assertEqual(str(env["GOTRUE_SMTP_PORT"]), "587", "relay exception is tcp 587 only")
        self.assertTrue(cfg_of("app-1")["services"]["auth"].get("healthcheck"), "GoTrue health check required")

    def test_no_service_on_app_host_resolves_db_by_name(self):  # `db` is removed on app-1
        for name in APP_SET:
            for k, v in (cfg_of("app-1")["services"][name].get("environment") or {}).items():
                self.assertNotRegex(str(v), r"@db[:/]|//db[:/]", "%s.%s points at removed service db" % (name, k))

    def test_storage_volume_and_deps(self):
        s = cfg_of("app-1")["services"]["storage"]
        binds = {(v.get("source"), v.get("target")) for v in s["volumes"]}
        self.assertIn(("/srv/lims/storage", "/var/lib/storage"), binds)
        self.assertTrue(all(v.get("type") == "bind" for v in s["volumes"]), "no docker named volumes for object data")
        self.assertEqual(set(s["depends_on"]), {"rest", "imgproxy"})

    def test_data_host_db_and_pgbouncer(self):
        s = cfg_of("data-1")["services"]
        self.assertRegex(s["db"]["image"], r"^registry\.lims\.internal/lims/postgres-pgbackrest@sha256:[0-9a-f]{64}$")
        db = {(v.get("source"), v.get("target")) for v in s["db"]["volumes"]}
        self.assertIn(("/srv/lims/pg/data", "/var/lib/postgresql/data"), db)
        self.assertTrue(any(t == "/etc/postgresql-custom/conf.d/zz-lims.conf" for _, t in db))
        self.assertTrue(any(t == "/etc/postgresql/pg_hba.conf" for _, t in db))
        self.assertEqual(int(s["db"].get("mem_limit") or 0), 26 * 1024 ** 3)
        for name, port in (("db", 5432), ("pgbouncer", 6432)):
            p = s[name]["ports"]
            self.assertEqual([(x["host_ip"], int(x["published"]), x["target"]) for x in p], [(DATA_WG, port, port)], name)

    def test_gateway_has_no_published_port_ac_06_2(self):
        if decision() == "fallback":
            gw = cfg_of("data-1")["services"]["api-gw"]
            self.assertEqual([(p["host_ip"], int(p["published"])) for p in gw["ports"]], [(DATA_WG, 8000)])
            return
        for name in APP_SET:
            self.assertFalse(cfg_of("app-1")["services"][name].get("ports"), "%s publishes a port on app-1" % name)

    def test_published_ports_tool_on_real_config_ac_01_3(self):
        for host, (_, wg) in LAYERS.items():
            only = DATA_SET if host == "data-1" else APP_SET
            if decision() == "fallback":
                if host == "app-1":
                    continue
                only = DATA_SET | APP_SET
            with tempfile.TemporaryDirectory() as td:
                f = Path(td) / "c.json"
                f.write_text(json.dumps(cfg_of(host)), encoding="utf-8")
                r = subprocess.run([sys.executable, "-B", str(PUBLISHED), "--wg-ip", wg, "--only", ",".join(sorted(only)),
                                    str(f)], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, "%s: %s%s" % (host, r.stdout, r.stderr))

    def test_every_started_service_has_limits_and_no_docker_sock(self):  # TRD s5.7 hardening defaults
        for host, names in (("data-1", DATA_SET), ("app-1", APP_SET)):
            if host == "app-1" and decision() == "fallback":
                continue
            for n in names:
                svc = cfg_of(host)["services"][n]
                self.assertTrue(svc.get("mem_limit"), "%s/%s mem_limit" % (host, n))
                self.assertTrue(svc.get("pids_limit"), "%s/%s pids_limit" % (host, n))
                for v in svc.get("volumes") or []:
                    self.assertNotIn("docker.sock", str(v.get("source")), "%s mounts the docker socket" % n)

    def test_override_files_carry_no_example_secrets(self):
        bad = re.compile(r"your-super-secret|your-.*-password|supabase-demo|postgres:postgres", re.I)
        for f in sorted(SUPA.glob("override*.yml")):
            self.assertIsNone(bad.search(f.read_text(encoding="utf-8")), "%s contains an example secret" % f.name)
        self.assertTrue(list(SUPA.glob("override*.yml")), "missing override files")


# ================================================================ 5. Envoy trimmed
class EnvoyTrimTest(unittest.TestCase):
    def lds(self):
        for v in cfg_of("data-1" if decision() == "fallback" else "app-1")["services"]["api-gw"]["volumes"]:
            if "lds" in str(v.get("target")):
                return v
        raise AssertionError("api-gw mounts no lds file")

    def test_trimmed_lds_mounted_from_outside_upstream(self):
        v = self.lds()
        src = Path(v["source"]).resolve()
        self.assertTrue(src.is_file(), "trimmed lds file missing: %s" % src)
        self.assertNotIn(UP.resolve(), src.parents, "upstream/ must stay byte-for-byte; trimmed copy lives outside")
        self.assertNotEqual(sha256(src), sha256(UP / "volumes/api/envoy/lds.template.yaml"), "lds not trimmed")

    def test_trimmed_lds_drops_unused_backends_keeps_used(self):
        text = Path(self.lds()["source"]).read_text(encoding="utf-8")
        code = "\n".join(l.split("#", 1)[0] for l in text.splitlines())
        for gone in ("functions", "studio", "meta", "realtime"):
            self.assertNotRegex(code, r"(?i)\b%s\b" % gone, "%s still referenced by the gateway" % gone)
        for kept in ("auth", "rest", "storage"):
            self.assertRegex(code, r"(?i)\b%s\b" % kept, "%s route/cluster missing" % kept)


if __name__ == "__main__":
    unittest.main()
