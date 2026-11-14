"""T-14 tests (tester role), part 2: the deploy-time probe scripts driven by a FAKE `docker` on PATH (pure logic; the real run
is infra/tests/integration/test_t14_live.py). Scripts under test (writer deliverables, infra/tests/internal/):
  renderer_egress.sh   AC-09.1   sandbox_envelope.sh  AC-10.1   valkey_ephemeral.sh  AC-11.1   egress_probe.sh  AC-09.3

CONTRACTS (writer meets them or files a dispute):
 * All scripts: bash, exit 0 = every check ok, 1 = a check failed, 2 = usage / missing required env; TAP-ish `ok N - ..` /
   `not ok N - ..` lines. They must be FAIL-CLOSED: a stopped container, a missing probe tool, a CLI error or an unparseable
   answer is a failure, never a pass (otherwise every "must be blocked" probe passes vacuously).
 * The fake docker understands (anything else exits 1):
     docker inspect [-f '{{.A.B}}' | -f '{{json .A.B}}'] NAME     (JSON array of the real `docker inspect` document; no range/if)
     docker exec [opts] NAME nc -z -w S HOST PORT                  success iff NAME>HOST:PORT is in the reach list
     docker exec [opts] NAME sh -c '... command -v nc ...'         success iff the tool is installed in NAME
     docker exec [opts] NAME curl ... https://FQDN/ ...            prints the status code configured for NAME>FQDN (default 000)
     docker exec [opts] NAME valkey-cli [auth opts] CONFIG GET K   prints `K` then the value (the real two-line shape)
     docker run [opts] --network container:NAME IMAGE nc -z -w S HOST PORT   same as exec; fails (125) if IMAGE is not known
     docker run [opts] --network container:NAME IMAGE true         exit 0 if IMAGE is known (positive control)
     docker image inspect IMAGE                                   exit 0 if IMAGE is known
   so a script may probe through `exec` or through a helper container sharing the netns (`PROBE_IMAGE`, digest-pinned).
   `python3` is provided on PATH (the fake maps it to the test interpreter) for JSON parsing; jq is NOT guaranteed.
 * env interface
     renderer_egress.sh : RENDERER_CONTAINER (required), DATA_WG_IP (required), PROBE_IMAGE (optional), SANDBOX_IP (optional)
     sandbox_envelope.sh: SANDBOX_CONTAINER, SANDBOX_PORT, WORKER_CONTAINERS (space list), DENY_CONTAINERS (space list) required;
                          DATA_WG_IP (optional; adds DB-host probes)
     valkey_ephemeral.sh: VALKEY_CONTAINER (required)
     egress_probe.sh    : `auth` (T-05, unchanged) | `db <container>` | `edge <container>` | `proxy <container>`; env DATA_WG_IP
                          required for db/edge; PROXY_ALLOWED_FQDN + PROXY_DENIED_FQDN required for proxy; SMTP_RELAY_HOST for auth.
 * `proxy`: allowed FQDN passes unless the status is one of 000/403/407/5xx; denied FQDN passes ONLY with exactly 403.
Stdlib only. Missing script = FAIL.
Run: python -B -m unittest discover -s infra/tests/static -p "test_t14_*.py" -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
INTERNAL = ROOT / "infra" / "tests" / "internal"
DATA_WG = "10.79.0.11"
GiB = 1024 ** 3

SHIM_PY = r'''
import json, os, re, sys
st = json.load(open(os.environ["SHIM_STATE"]))
a = sys.argv[1:]
C = st["containers"]

def die(code, msg=""):
    sys.stderr.write(msg + "\n"); sys.exit(code)

def path(doc, p):
    for k in p.strip(".").split("."):
        if k == "": continue
        doc = doc.get(k) if isinstance(doc, dict) else None
        if doc is None: return None
    return doc

def running(name):
    return name in C and C[name].get("running", True)

if not a: die(1)
cmd = a[0]
if cmd == "inspect":
    fmt = None; names = []
    i = 1
    while i < len(a):
        if a[i] in ("-f", "--format"): fmt = a[i + 1]; i += 2; continue
        if a[i].startswith("-"): i += 1; continue
        names.append(a[i]); i += 1
    if len(names) != 1 or names[0] not in C: die(1, "Error: No such object")
    doc = C[names[0]]["inspect"]
    doc.setdefault("State", {})["Running"] = C[names[0]].get("running", True)
    if fmt is None:
        print(json.dumps([doc])); sys.exit(0)
    m = re.fullmatch(r"\{\{\s*(json\s+)?(\.[A-Za-z0-9_.]*)\s*\}\}", fmt.strip())
    if not m: die(3, "fake docker: unsupported template " + fmt)
    v = path(doc, m.group(2))
    if m.group(1): print(json.dumps(v))
    else: print("<no value>" if v is None else (str(v).lower() if isinstance(v, bool) else v))
    sys.exit(0)

def probe(src, rest):
    if not running(src): die(1, "Error: No such container: " + src)
    t = C[src].get("tools", [])
    if rest[:1] == ["sh"] and "-c" in rest:
        s = rest[rest.index("-c") + 1]
        sys.exit(0 if any(re.search(r"\b" + re.escape(x) + r"\b", s) for x in t) else 1)
    if rest and rest[0] in ("true", "echo"):
        sys.exit(0)
    if rest and rest[0] == "nc":
        h, p = rest[-2], rest[-1]
        sys.exit(0 if (src + ">" + h + ":" + p) in st.get("reach", []) else 1)
    if rest and rest[0] == "curl":
        url = [x for x in rest if x.startswith("http")][-1]
        host = re.sub(r"^https?://", "", url).split("/")[0].split(":")[0]
        print(st.get("http", {}).get(src + ">" + host, "000")); sys.exit(0)
    if rest and rest[0] == "valkey-cli":
        v = st.get("valkey", {})
        if v.get("cli_error"): sys.stderr.write("error\n"); sys.exit(1)
        if v.get("noauth"): print("NOAUTH Authentication required."); sys.exit(0)
        u = [x.upper() for x in rest]
        if "CONFIG" in u and "GET" in u:
            k = rest[u.index("GET") + 1]
            print(k); print(v.get(k, "")); sys.exit(0)
        sys.exit(1)
    sys.exit(1)

if cmd == "image":
    sys.exit(0 if a[-1] in st.get("images", []) else 1)
if cmd == "exec":
    i = 1
    while i < len(a) and a[i].startswith("-"):
        i += 2 if a[i] in ("-u", "--user", "-e", "--env", "-w", "--workdir") else 1
    probe(a[i], a[i + 1:]);
if cmd == "run":
    src = None; i = 1
    while i < len(a):
        if a[i] == "--network" and a[i + 1].startswith("container:"): src = a[i + 1][10:]
        if a[i] in ("--network", "--name", "-u", "--user", "--entrypoint", "-e", "--cap-drop", "--security-opt", "--pull"): i += 2; continue
        if a[i].startswith("-"): i += 1; continue
        break
    img = a[i]
    if img not in st.get("images", []): die(125, "Unable to find image " + img)
    if src is None: die(1)
    probe(src, a[i + 1:])
sys.exit(1)
'''


def bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", "/usr/bin/bash"):
        if os.path.exists(c):
            return c
    import shutil
    return shutil.which("bash")


class Fake:
    """A throw-away dir with fake `docker` and `python3` first on PATH plus the state file."""

    def __init__(self):
        self.td = tempfile.TemporaryDirectory()
        d = Path(self.td.name)
        (d / "shim.py").write_text(SHIM_PY, encoding="utf-8")
        for name, body in (("docker", 'exec "%s" "%s" "$@"' % (Path(sys.executable).as_posix(), (d / "shim.py").as_posix())),
                           ("python3", 'exec "%s" "$@"' % Path(sys.executable).as_posix())):
            (d / name).write_text("#!/usr/bin/env bash\n%s\n" % body, encoding="utf-8", newline="\n")
        self.state_file = d / "state.json"
        self.dir = d

    def run(self, script, args, state, env=None, timeout=300):  # Git Bash on Windows spawns slowly; 60 s flaked (timeout only, no assertion changed)
        self.state_file.write_text(json.dumps(state), encoding="utf-8")
        e = dict(os.environ, PATH=str(self.dir) + os.pathsep + os.environ["PATH"], SHIM_STATE=str(self.state_file))
        e.pop("PROBE_IMAGE", None)
        e.update(env or {})
        return subprocess.run([bash(), str(INTERNAL / script), *args], capture_output=True, text=True, env=e, timeout=timeout)

    def close(self):
        self.td.cleanup()


def need_script(name):
    p = INTERNAL / name
    if not p.is_file():
        raise AssertionError("missing infra/tests/internal/%s" % name)
    return p


class _Base:
    SCRIPT = ""

    def setUp(self):
        self.fake = Fake()
        self.addCleanup(self.fake.close)

    def test_script_exists_and_parses(self):
        p = need_script(self.SCRIPT)
        r = subprocess.run([bash(), "-n", str(p)], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("set -u", p.read_text(encoding="utf-8"), "unset variables must not pass silently")


# ================================================================= renderer_egress.sh (AC-09.1)
REND = "renderer-1"
DENIED = ["1.1.1.1:443", "8.8.8.8:53", "169.254.169.254:80", DATA_WG + ":5432", DATA_WG + ":6432"]


class RendererEgress(_Base, unittest.TestCase):
    SCRIPT = "renderer_egress.sh"

    def state(self, reach=(), tools=("nc",), running=True, images=()):
        return {"containers": {REND: {"running": running, "tools": list(tools), "inspect": {}}}, "reach": list(reach),
                "images": list(images)}

    def go(self, reach=(), env=None, **kw):
        e = {"RENDERER_CONTAINER": REND, "DATA_WG_IP": DATA_WG}
        e.update(env or {})
        return self.fake.run(self.SCRIPT, [], self.state(reach, **kw), e)

    def test_isolated_renderer_passes(self):  # AC-09.1
        need_script(self.SCRIPT)
        r = self.go()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("ok ", r.stdout)
        self.assertNotIn("not ok", r.stdout)

    def test_probes_cover_internet_metadata_db_and_peers(self):  # AC-09.1 wording
        need_script(self.SCRIPT)
        for leak in DENIED + ["10.79.0.12:22", "172.30.40.11:8080"]:
            r = self.go([REND + ">" + leak], env={"SANDBOX_IP": "172.30.40.11"})
            self.assertEqual(r.returncode, 1, "leak %s not detected\n%s" % (leak, r.stdout))
            self.assertIn("not ok", r.stdout)

    def test_cannot_pass_vacuously(self):
        need_script(self.SCRIPT)
        self.assertEqual(self.go(running=False).returncode, 1, "stopped container")
        self.assertEqual(self.go(tools=()).returncode, 1, "no nc and no probe image: all denies would 'pass'")

    def test_probe_image_path(self):  # helper container in the renderer's netns
        need_script(self.SCRIPT)
        env = {"PROBE_IMAGE": "registry.invalid/probe@sha256:" + "a" * 64}
        ok = self.go(env=env, tools=(), images=[env["PROBE_IMAGE"]])
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        leak = self.go([REND + ">1.1.1.1:443"], env=env, tools=(), images=[env["PROBE_IMAGE"]])
        self.assertEqual(leak.returncode, 1, leak.stdout)
        missing = self.go(env=env, tools=(), images=[])
        self.assertEqual(missing.returncode, 1, "image absent -> docker run fails -> must not read as 'blocked'")

    def test_usage(self):
        need_script(self.SCRIPT)
        for env in ({"DATA_WG_IP": DATA_WG}, {"RENDERER_CONTAINER": REND}):
            r = self.fake.run(self.SCRIPT, [], self.state(), env)
            self.assertEqual(r.returncode, 2, env)


# ================================================================= sandbox_envelope.sh (AC-10.1)
SBX, W1, W2, APIA, RNDR = "sandbox-1", "worker-a-1", "worker-b-1", "api-a-1", "renderer-1"
PORT = "8080"


def sandbox_inspect():
    return {
        "Config": {"User": "10001", "Env": ["LIMS_RENDER_SANDBOX_TOKEN_FILE=/run/secrets/pdf_sandbox_inbound_token", "PATH=/usr/bin"],
                   "Healthcheck": {"Test": ["CMD", "node", "-e", "fetch('http://127.0.0.1:8080/internal/health')"]}},
        "HostConfig": {"ReadonlyRootfs": True, "Tmpfs": {"/work": "rw,noexec,nosuid,size=262144k"}, "CapDrop": ["ALL"], "CapAdd": None,
                       "Memory": 512 * 1024 ** 2, "NanoCpus": 10 ** 9, "PidsLimit": 64, "Privileged": False,
                       "SecurityOpt": ["no-new-privileges:true"], "NetworkMode": "render_net", "PortBindings": {}},
        "Mounts": [{"Type": "bind", "Source": "/run/lims/secrets/pdf-sandbox/pdf_sandbox_inbound_token",
                    "Destination": "/run/secrets/pdf_sandbox_inbound_token", "RW": False}],
        "NetworkSettings": {"Networks": {"render_net": {"IPAddress": "172.30.40.11"}}, "Ports": {}},
    }


GOOD_REACH = [W1 + ">172.30.40.11:" + PORT, W2 + ">172.30.40.11:" + PORT]


class SandboxEnvelope(_Base, unittest.TestCase):
    SCRIPT = "sandbox_envelope.sh"
    ENV = {"SANDBOX_CONTAINER": SBX, "SANDBOX_PORT": PORT, "WORKER_CONTAINERS": W1 + " " + W2, "DENY_CONTAINERS": APIA + " " + RNDR}

    def state(self, mutate=None, reach=None, tools=("nc",), running=True):
        doc = sandbox_inspect()
        if mutate:
            mutate(doc)
        cont = {SBX: {"running": running, "tools": list(tools), "inspect": doc}}
        for n in (W1, W2, APIA, RNDR):
            cont[n] = {"running": True, "tools": list(tools), "inspect": {}}
        return {"containers": cont, "reach": GOOD_REACH if reach is None else reach, "images": []}

    def go(self, **kw):
        env = dict(self.ENV, **kw.pop("env", {}))
        return self.fake.run(self.SCRIPT, [], self.state(**kw), env)

    def test_good_envelope_passes(self):  # AC-10.1
        need_script(self.SCRIPT)
        r = self.go()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("not ok", r.stdout)

    def test_each_envelope_violation_is_caught(self):  # AC-10.1 + 07-SEC AB-6
        need_script(self.SCRIPT)
        H = lambda d: d["HostConfig"]
        muts = {
            "root user": lambda d: d["Config"].update(User="0"),
            "empty user (image default root)": lambda d: d["Config"].update(User=""),
            "root by name": lambda d: d["Config"].update(User="root"),
            "writable rootfs": lambda d: H(d).update(ReadonlyRootfs=False),
            "no /work tmpfs": lambda d: H(d).update(Tmpfs={}),
            "caps kept": lambda d: H(d).update(CapDrop=[]),
            "cap_add": lambda d: H(d).update(CapAdd=["NET_ADMIN"]),
            "memory 1 GiB": lambda d: H(d).update(Memory=GiB),
            "memory 512 MiB + 1": lambda d: H(d).update(Memory=512 * 1024 ** 2 + 1),
            "memory unlimited": lambda d: H(d).update(Memory=0),
            "2 CPUs": lambda d: H(d).update(NanoCpus=2 * 10 ** 9),
            "no cpu limit": lambda d: H(d).update(NanoCpus=0),
            "pids 128": lambda d: H(d).update(PidsLimit=128),
            "pids unlimited": lambda d: H(d).update(PidsLimit=0),
            "privileged": lambda d: H(d).update(Privileged=True),
            "no-new-privileges missing": lambda d: H(d).update(SecurityOpt=[]),
            "second network": lambda d: d["NetworkSettings"]["Networks"].update(app_net={"IPAddress": "172.30.20.9"}),
            "published port": lambda d: d["NetworkSettings"].update(Ports={"8080/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8080"}]}),
            "second mount": lambda d: d["Mounts"].append({"Type": "bind", "Source": "/var/run/docker.sock", "Destination": "/var/run/docker.sock", "RW": True}),
            "no secret": lambda d: d.update(Mounts=[]),
            "wrong secret": lambda d: d["Mounts"][0].update(Source="/run/lims/secrets/renderer/renderer_inbound_token",
                                                          Destination="/run/secrets/renderer_inbound_token"),
            "writable secret": lambda d: d["Mounts"][0].update(RW=True),
            "proxy variable": lambda d: d["Config"]["Env"].append("HTTPS_PROXY=http://squid:3128"),
            "health check missing": lambda d: d["Config"].update(Healthcheck=None),
            "health check on wrong path": lambda d: d["Config"].update(Healthcheck={"Test": ["CMD", "true"]}),
        }
        for name, m in muts.items():
            r = self.go(mutate=m)
            self.assertEqual(r.returncode, 1, "%s not detected\n%s" % (name, r.stdout))
            self.assertIn("not ok", r.stdout, name)

    def test_exact_limits_are_accepted(self):  # boundary: <= 512 MiB, pids 64
        need_script(self.SCRIPT)
        self.assertEqual(self.go(mutate=lambda d: d["HostConfig"].update(Memory=256 * 1024 ** 2, PidsLimit=32)).returncode, 0)

    def test_cpu_quota_form_is_understood(self):  # CpuQuota/CpuPeriod = 1 CPU, how `cpus:` is sometimes reported
        need_script(self.SCRIPT)
        def m(d):
            d["HostConfig"].update(NanoCpus=0, CpuQuota=100000, CpuPeriod=100000)
        self.assertEqual(self.go(mutate=m).returncode, 0)

    def test_reachability_from_workers_only(self):  # AC-10.1 (or br_netfilter outcome -> DECISION.md)
        need_script(self.SCRIPT)
        for extra in (APIA, RNDR):
            r = self.go(reach=GOOD_REACH + [extra + ">172.30.40.11:" + PORT])
            self.assertEqual(r.returncode, 1, "%s reaches the sandbox\n%s" % (extra, r.stdout))
        for gone in GOOD_REACH:
            r = self.go(reach=[x for x in GOOD_REACH if x != gone])
            self.assertEqual(r.returncode, 1, "worker path %s broken but not reported" % gone)

    def test_no_outbound_from_sandbox(self):
        need_script(self.SCRIPT)
        for t in ("1.1.1.1:443", "169.254.169.254:80", DATA_WG + ":5432", "172.30.40.1:53"):
            r = self.go(reach=GOOD_REACH + [SBX + ">" + t], env={"DATA_WG_IP": DATA_WG})
            self.assertEqual(r.returncode, 1, "outbound %s not detected" % t)

    def test_cannot_pass_vacuously(self):
        need_script(self.SCRIPT)
        self.assertEqual(self.go(running=False).returncode, 1)
        self.assertEqual(self.go(tools=()).returncode, 1, "no probe tool anywhere")
        self.assertEqual(self.go(reach=[]).returncode, 1, "workers must be shown to reach it (positive control)")

    def test_usage(self):
        need_script(self.SCRIPT)
        for drop in self.ENV:
            env = {k: v for k, v in self.ENV.items() if k != drop}
            st = self.state()
            self.fake.state_file.write_text(json.dumps(st), encoding="utf-8")
            e = {k: v for k, v in os.environ.items() if k not in self.ENV}
            e.update(PATH=str(self.fake.dir) + os.pathsep + os.environ["PATH"], SHIM_STATE=str(self.fake.state_file), **env)
            r = subprocess.run([bash(), str(INTERNAL / self.SCRIPT)], capture_output=True, text=True, env=e)
            self.assertEqual(r.returncode, 2, "missing %s" % drop)


# ================================================================= valkey_ephemeral.sh (AC-11.1)
VK = "valkey-1"


def valkey_inspect():
    return {"Mounts": [], "HostConfig": {"Binds": None, "Tmpfs": {"/data": "rw,size=65536k"}, "PortBindings": {}},
            "Config": {"Cmd": ["valkey-server", "--save", "", "--appendonly", "no"], "Volumes": None},
            "NetworkSettings": {"Networks": {"app_net": {"IPAddress": "172.30.20.7"}}, "Ports": {"6379/tcp": None}}}


class ValkeyEphemeral(_Base, unittest.TestCase):
    SCRIPT = "valkey_ephemeral.sh"

    def state(self, mutate=None, valkey=None, running=True):
        doc = valkey_inspect()
        if mutate:
            mutate(doc)
        return {"containers": {VK: {"running": running, "tools": [], "inspect": doc}}, "valkey": valkey or {"appendonly": "no", "save": ""},
                "reach": [], "images": []}

    def go(self, **kw):
        return self.fake.run(self.SCRIPT, [], self.state(**kw), {"VALKEY_CONTAINER": VK})

    def test_ephemeral_instance_passes(self):  # AC-11.1
        need_script(self.SCRIPT)
        r = self.go()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("not ok", r.stdout)

    def test_each_persistence_or_exposure_defect_is_caught(self):  # AC-11.1, 04 S11
        need_script(self.SCRIPT)
        cases = {
            "RDB snapshots on": dict(valkey={"appendonly": "no", "save": "3600 1 300 100"}),
            "AOF on": dict(valkey={"appendonly": "yes", "save": ""}),
            "named volume": dict(mutate=lambda d: d["Mounts"].append({"Type": "volume", "Name": "v", "Destination": "/data"})),
            "anonymous VOLUME /data from the image": dict(mutate=lambda d: d["Mounts"].append({"Type": "volume", "Name": "a1b2", "Destination": "/data"})),
            "bind mount": dict(mutate=lambda d: d["Mounts"].append({"Type": "bind", "Source": "/srv/v", "Destination": "/data"})),
            "published port": dict(mutate=lambda d: d["NetworkSettings"].update(Ports={"6379/tcp": [{"HostIp": "0.0.0.0", "HostPort": "6379"}]})),
            "also on edge_net": dict(mutate=lambda d: d["NetworkSettings"]["Networks"].update(edge_net={"IPAddress": "172.30.10.5"})),
            "also on db_net": dict(mutate=lambda d: d["NetworkSettings"]["Networks"].update(db_net={"IPAddress": "172.30.50.5"})),
            "host network": dict(mutate=lambda d: d["NetworkSettings"].update(Networks={"host": {}})),
        }
        for name, kw in cases.items():
            r = self.go(**kw)
            self.assertEqual(r.returncode, 1, "%s not detected\n%s" % (name, r.stdout))
            self.assertIn("not ok", r.stdout, name)

    def test_cli_failure_is_not_read_as_empty_save(self):  # NOAUTH / broken CLI print nothing useful: must FAIL
        need_script(self.SCRIPT)
        self.assertEqual(self.go(valkey={"cli_error": True}).returncode, 1)
        self.assertEqual(self.go(valkey={"noauth": True}).returncode, 1)
        self.assertEqual(self.go(running=False).returncode, 1)

    def test_usage(self):
        need_script(self.SCRIPT)
        e = {k: v for k, v in os.environ.items() if k != "VALKEY_CONTAINER"}
        self.assertEqual(subprocess.run([bash(), str(INTERNAL / self.SCRIPT)], capture_output=True, text=True, env=e).returncode, 2)


# ================================================================= egress_probe.sh new modes (AC-09.3)
SVC = {"db": "api-a-1", "edge": "web-a-1", "proxy": "worker-a-1"}
ALLOW_FQDN, DENY_FQDN = "api.allowed.example", "evil.example"


class EgressProbeModes(_Base, unittest.TestCase):
    SCRIPT = "egress_probe.sh"
    ENV = {"DATA_WG_IP": DATA_WG, "PROXY_ALLOWED_FQDN": ALLOW_FQDN, "PROXY_DENIED_FQDN": DENY_FQDN}

    def state(self, who, reach=(), http=None, tools=("nc", "curl"), running=True):
        return {"containers": {who: {"running": running, "tools": list(tools), "inspect": {}}}, "reach": list(reach),
                "http": http or {}, "images": []}

    def go(self, mode, reach=(), http=None, **kw):
        who = SVC[mode]
        return self.fake.run(self.SCRIPT, [mode, who], self.state(who, [who + ">" + r for r in reach], http, **kw), self.ENV)

    DB_OK = [DATA_WG + ":5432", DATA_WG + ":6432"]

    def test_db_net_member_passes(self):  # AC-09.3 first clause (api-a, worker-a, rest, storage)
        need_script(self.SCRIPT)
        r = self.go("db", self.DB_OK)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_db_net_each_leak_and_each_broken_path(self):
        need_script(self.SCRIPT)
        for leak in ("1.1.1.1:443", "8.8.8.8:53", "169.254.169.254:80", DATA_WG + ":22", DATA_WG + ":9100", DATA_WG + ":9187", "10.79.0.14:443"):
            r = self.go("db", self.DB_OK + [leak])
            self.assertEqual(r.returncode, 1, "leak %s not detected\n%s" % (leak, r.stdout))
        for gone in self.DB_OK:
            self.assertEqual(self.go("db", [x for x in self.DB_OK if x != gone]).returncode, 1, gone)

    def test_edge_net_member_has_no_egress(self):  # web/portal: any TCP to the internet fails
        need_script(self.SCRIPT)
        self.assertEqual(self.go("edge", []).returncode, 0)
        for leak in ("1.1.1.1:443", "8.8.8.8:53", "169.254.169.254:80", DATA_WG + ":5432", DATA_WG + ":6432"):
            self.assertEqual(self.go("edge", [leak]).returncode, 1, leak)

    def test_proxy_allowed_403_denied(self):  # AC-09.3 last clause
        need_script(self.SCRIPT)
        who = SVC["proxy"]
        ok = {who + ">" + ALLOW_FQDN: "200", who + ">" + DENY_FQDN: "403"}
        self.assertEqual(self.go("proxy", self.DB_OK, ok).returncode, 0)
        bad = {
            "denied FQDN served (200)": {**ok, who + ">" + DENY_FQDN: "200"},
            "denied FQDN unreachable (000) is not a 403": {**ok, who + ">" + DENY_FQDN: "000"},
            "denied gets 407": {**ok, who + ">" + DENY_FQDN: "407"},
            "allowed FQDN blocked (403)": {**ok, who + ">" + ALLOW_FQDN: "403"},
            "allowed FQDN dead (000)": {**ok, who + ">" + ALLOW_FQDN: "000"},
            "allowed FQDN 502": {**ok, who + ">" + ALLOW_FQDN: "502"},
        }
        for name, http in bad.items():
            r = self.go("proxy", self.DB_OK, http)
            self.assertEqual(r.returncode, 1, "%s\n%s" % (name, r.stdout))

    def test_proxy_mode_also_checks_direct_egress_is_closed(self):  # api/worker's ONLY internet path is Squid
        need_script(self.SCRIPT)
        who = SVC["proxy"]
        http = {who + ">" + ALLOW_FQDN: "200", who + ">" + DENY_FQDN: "403"}
        self.assertEqual(self.go("proxy", self.DB_OK + ["1.1.1.1:443"], http).returncode, 1)

    def test_cannot_pass_vacuously(self):
        need_script(self.SCRIPT)
        for mode in ("db", "edge"):
            self.assertEqual(self.go(mode, self.DB_OK if mode == "db" else [], running=False).returncode, 1, mode)
            self.assertEqual(self.go(mode, self.DB_OK if mode == "db" else [], tools=()).returncode, 1, mode)

    def test_usage(self):
        need_script(self.SCRIPT)
        st = self.state("x")
        self.assertEqual(self.fake.run(self.SCRIPT, ["bogus-mode", "x"], st, self.ENV).returncode, 2)
        self.assertEqual(self.fake.run(self.SCRIPT, ["db"], st, self.ENV).returncode, 2, "container name required")
        self.assertEqual(self.fake.run(self.SCRIPT, ["db", "x"], st, {"DATA_WG_IP": ""}).returncode, 2)
        self.assertEqual(self.fake.run(self.SCRIPT, ["proxy", "x"], st, {"DATA_WG_IP": DATA_WG, "PROXY_ALLOWED_FQDN": "",
                                                                       "PROXY_DENIED_FQDN": ""}).returncode, 2)


if __name__ == "__main__":
    unittest.main()
