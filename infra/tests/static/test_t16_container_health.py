"""T-16 tests (tester role): `monitoring/textfile/container_health.sh` -> `lims_ops_container_health{service}` (02-TRD s11.1, AC-10.1
"health check", done_when "lims_ops_container_health for service pdf-sandbox = 1"). Driven by a FAKE `docker` on PATH; the envelope
probe `sandbox_envelope.sh` is already covered by test_t14_probes.SandboxEnvelope and is re-run by the T-16 verify.cmd.

CONTRACT (writer meets it or files a dispute):
 * Script: infra/monitoring/textfile/container_health.sh, bash, LF, `set -u`. Run every 30 s by root on the host (02-TRD s11.1).
 * Reads ONLY through the docker CLI, read-only: `docker ps` / `docker container ls` / `docker inspect` / `docker container inspect`
   (+ `docker info|version`). Anything else (exec, run, rm, restart, compose, ...) is a failure. No socket mount into containers.
 * Output: Prometheus text, one gauge `lims_ops_container_health{service="<compose service>"}` per service, value 1 iff the
   container is running AND its Docker healthcheck status is `healthy`; else 0 (starting, unhealthy, exited, no healthcheck: never 1).
   The label is the compose service name (label `com.docker.compose.service`). No other label, no container id/name in the output.
   Two containers of one service -> one series, 1 only if every container is healthy. Written atomically to
   $TEXTFILE_DIR/<name>.prom (one *.prom file, no temp file left behind); stdout when TEXTFILE_DIR is unset.
 * Fail closed: docker unreadable (daemon down) -> exit != 0 and no sample claiming health survives (a stale file is removed or
   rewritten without a `1`). Label values come from docker and are untrusted: they can never forge or alter another sample.
 * Scheduling: an Ansible-installed systemd timer, cadence 30 s, whose service runs container_health.sh with
   TEXTFILE_DIR=/var/lib/node_exporter/textfile (any role under infra/ansible; the writer chooses which).
 * The fake docker understands (anything else exits 1 and fails the test):
     docker ps [-a|--all] [-q] [--no-trunc] [--filter label=K[=V]|name=RE|status=S|health=H] [--format '{{.ID}} {{.Names}} {{.State}}
              {{.Status}} {{.Image}} {{.Labels}} {{.Label "k"}}']     (running containers only unless -a)
     docker inspect [-f|--format TEMPLATE] NAME_OR_ID...   (JSON array without a format; TEMPLATE may use {{.A.B}}, {{json .A.B}},
              {{index .Config.Labels "k"}}; no range/if/with. Like the real CLI, `.State.Health.Status` on a container WITHOUT a
              healthcheck is a "nil pointer" error, exit 1 for that container.)
     docker container ls|list|ps|inspect ...   same as the short forms;   docker info|version   exit 0
Run: python -B -m unittest discover -s infra/tests/static -p "test_t16_*.py" -v
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "infra" / "monitoring" / "textfile" / "container_health.sh"
ANSIBLE = ROOT / "infra" / "ansible"
METRIC = "lims_ops_container_health"

SHIM_PY = r'''
import json, os, re, sys
sys.stdout.reconfigure(newline="\n")  # Windows: no CRLF in what the script reads back
sys.stderr.reconfigure(newline="\n")
a = sys.argv[1:]
open(os.environ["SHIM_LOG"], "a").write(json.dumps(a) + "\n")
st = json.load(open(os.environ["SHIM_STATE"]))

def die(code, msg=""):
    sys.stderr.write(msg + "\n"); sys.exit(code)

if st.get("docker_down"):
    die(1, "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")

def labels(c):
    d = {"com.docker.compose.project": "lims", "com.docker.compose.service": c["service"]}
    d.update(c.get("labels") or {})
    return d

def doc(c):
    state = {"Status": "running" if c["running"] else "exited", "Running": bool(c["running"])}
    if c.get("health") is not None:
        state["Health"] = {"Status": c["health"]}
    return {"Id": c["id"], "Name": "/" + c["name"], "State": state,
            "Config": {"Image": c.get("image", "img"), "Labels": labels(c)}}

def status_text(c):
    if not c["running"]:
        return "Exited (0) 2 minutes ago"
    h = c.get("health")
    return "Up 3 minutes" + ({"healthy": " (healthy)", "unhealthy": " (unhealthy)", "starting": " (health: starting)"}.get(h, "") if h else "")

def lookup(d, ref):
    for ident in st["containers"]:
        if ident["name"] == ref or ident["id"].startswith(ref):
            return ident
    return None

def fmt_get(obj, path):
    parts = [p for p in path.strip(".").split(".") if p]
    for i, k in enumerate(parts):
        if not isinstance(obj, dict) or k not in obj:
            if i < len(parts) - 1 or obj is None:
                raise RuntimeError("template: nil pointer evaluating %s" % path)
            return "<no value>"
        obj = obj[k]
    return obj

def render(tpl, d):
    def one(m):
        e = m.group(1).strip()
        mm = re.fullmatch(r'index \.Config\.Labels "([^"]*)"', e)
        if mm:
            return d["Config"]["Labels"].get(mm.group(1), "")
        if e.startswith("json "):
            return json.dumps(fmt_get(d, e[5:].strip()), separators=(",", ":"))
        v = fmt_get(d, e)
        return ("true" if v else "false") if isinstance(v, bool) else str(v)
    return re.sub(r"\{\{(.*?)\}\}", one, tpl)

def ps_render(tpl, c):
    def one(m):
        e = m.group(1).strip()
        mm = re.fullmatch(r'\.Label "([^"]*)"', e)
        if mm:
            return labels(c).get(mm.group(1), "")
        table = {".ID": c["id"], ".Names": c["name"], ".State": "running" if c["running"] else "exited",
                 ".Status": status_text(c), ".Image": c.get("image", "img"),
                 ".Labels": ",".join("%s=%s" % kv for kv in labels(c).items())}
        if e not in table:
            die(1, "fake docker: unsupported ps format token %s" % e)
        return table[e]
    return re.sub(r"\{\{(.*?)\}\}", one, tpl)

if a[:1] == ["container"] and len(a) > 1:
    a = [{"ls": "ps", "list": "ps"}.get(a[1], a[1])] + a[2:]
cmd, rest = (a[0] if a else ""), a[1:]

if cmd in ("info", "version"):
    sys.exit(0)

if cmd == "ps":
    allc, quiet, fmt, filters, i, full = False, False, None, [], 0, False
    while i < len(rest):
        t = rest[i]
        if t in ("-a", "--all"): allc = True
        elif t in ("-q", "--quiet"): quiet = True
        elif t in ("-aq", "-qa"): allc = quiet = True
        elif t == "--no-trunc": full = True
        elif t in ("--format",): fmt = rest[i + 1]; i += 1
        elif t.startswith("--format="): fmt = t.split("=", 1)[1]
        elif t in ("-f", "--filter"): filters.append(rest[i + 1]); i += 1
        elif t.startswith("--filter="): filters.append(t.split("=", 1)[1])
        else: die(1, "fake docker: unsupported ps option %s" % t)
        i += 1
    out = []
    for c in st["containers"]:
        if not allc and not c["running"]:
            continue
        ok = True
        for f in filters:
            k, _, v = f.partition("=")
            if k == "label":
                lk, _, lv = v.partition("=")
                ok &= (lk in labels(c)) and (not lv or labels(c)[lk] == lv)
            elif k == "name": ok &= re.search(v, c["name"]) is not None
            elif k == "status": ok &= ({"running": c["running"], "exited": not c["running"]}.get(v, True))
            elif k == "health": ok &= c.get("health") == v
            else: die(1, "fake docker: unsupported ps filter %s" % f)
        if ok: out.append(c)
    for c in out:
        if quiet: print(c["id"] if full else c["id"][:12])
        elif fmt: print(ps_render(fmt, c))
        else: print("%s  %s  %s" % (c["id"][:12], c["name"], status_text(c)))
    sys.exit(0)

if cmd == "inspect":
    fmt, names, i = None, [], 0
    while i < len(rest):
        t = rest[i]
        if t in ("-f", "--format"): fmt = rest[i + 1]; i += 1
        elif t.startswith("--format="): fmt = t.split("=", 1)[1]
        elif t in ("--type",): i += 1
        elif t.startswith("-"): die(1, "fake docker: unsupported inspect option %s" % t)
        else: names.append(t)
        i += 1
    if not names:
        die(1, "docker inspect: requires at least 1 argument")
    docs, rc = [], 0
    for n in names:
        c = lookup(st, n)
        if c is None:
            sys.stderr.write("Error: No such object: %s\n" % n); rc = 1
        else:
            docs.append(doc(c))
    if fmt is None:
        print(json.dumps(docs, indent=4))
    else:
        for d in docs:
            try:
                print(render(fmt, d))
            except RuntimeError as e:
                sys.stderr.write("Template parsing error: %s\n" % e); rc = 1
    sys.exit(rc)

die(1, "fake docker: unsupported command %r (container_health.sh must stay read-only: ps/inspect only)" % cmd)
'''


def bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", "/usr/bin/bash"):
        if os.path.exists(c):
            return c
    import shutil
    return shutil.which("bash")


def C(name, service, running=True, health="healthy", labels=None, cid=None):
    return {"id": cid or (("%012x" % (abs(hash(name)) % (16 ** 12))) + "f" * 52), "name": name, "service": service,
            "running": running, "health": health, "labels": labels}


def fleet(**overrides):
    base = {"pdf-sandbox": C("lims-pdf-sandbox-1", "pdf-sandbox"), "renderer": C("lims-renderer-1", "renderer"),
            "api-a": C("lims-api-a-1", "api-a"), "worker-a": C("lims-worker-a-1", "worker-a")}
    base.update(overrides)
    return [v for v in base.values() if v is not None]


SAMPLE = re.compile(r'^' + METRIC + r'\{service="((?:[^"\\\n]|\\.)*)"\} ([01])(?:\.0)?$')


class Run:
    def __init__(self, out, rc, err, files, log):
        self.out, self.rc, self.err, self.files, self.log = out, rc, err, files, log

    @property
    def text(self):  # the exported text, wherever it landed
        return self.files[0][1] if self.files else self.out

    @property
    def samples(self):
        return [l for l in self.text.splitlines() if l.strip() and not l.startswith("#")]

    def series(self):
        d = {}
        for l in self.samples:
            m = SAMPLE.match(l)
            assert m, "not a well-formed %s sample: %r" % (METRIC, l)
            assert m.group(1) not in d, "duplicate series for service %r" % m.group(1)
            d[m.group(1)] = int(m.group(2))
        return d

    def ones(self):  # every service reported healthy, tolerant of unparseable text (fail-closed checks)
        return re.findall(r'service="([^"]*)"\}\s+1(?:\.0)?\s*$', "\n".join(t for _, t in self.files) or self.out, re.M)

    def docker_subcommands(self):
        subs = set()
        for line in self.log:
            a = json.loads(line)
            subs.add(" ".join(a[:2]) if a[:1] == ["container"] else (a[0] if a else ""))
        return subs


class _Env(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.d = Path(self.td.name)
        self.bin, self.outdir = self.d / "bin", self.d / "out"
        self.bin.mkdir()
        self.outdir.mkdir()
        (self.bin / "shim.py").write_text(SHIM_PY, encoding="utf-8")
        py = Path(sys.executable).as_posix()
        for name, body in (("docker", 'exec "%s" "%s" "$@"' % (py, (self.bin / "shim.py").as_posix())),
                           ("python3", 'exec "%s" "$@"' % py), ("python", 'exec "%s" "$@"' % py)):
            (self.bin / name).write_text("#!/usr/bin/env bash\n%s\n" % body, encoding="utf-8", newline="\n")
        self.state, self.logf = self.d / "state.json", self.d / "docker.log"
        self.logf.write_text("", encoding="utf-8")

    def go(self, containers, down=False, textfile=True, stale=None):
        self.assertTrue(SCRIPT.is_file(), "missing infra/monitoring/textfile/container_health.sh")
        self.state.write_text(json.dumps({"containers": containers, "docker_down": down}), encoding="utf-8")
        if stale is not None:
            (self.outdir / "container_health.prom").write_text(stale, encoding="utf-8")
        env = dict(os.environ, PYTHONUTF8="1", SHIM_STATE=str(self.state), SHIM_LOG=str(self.logf), PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        env.pop("TEXTFILE_DIR", None)
        if textfile:
            env["TEXTFILE_DIR"] = self.outdir.as_posix()
        # C1.T-19-ruling: Git Bash's profile prepends /mingw64/bin, so put the fakes first inside the shell.
        cmd = ("command -v cygpath >/dev/null && B=\"$(cygpath -u '%s')\" || B='%s'; export PATH=\"$B:$PATH\"; "
               "cd '%s' && bash '%s'" % (str(self.bin), self.bin.as_posix(), ROOT.as_posix(), SCRIPT.as_posix()))
        r = subprocess.run([bash(), "-c", cmd], env=env, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL)
        files = [(p.name, p.read_text(encoding="utf-8")) for p in sorted(self.outdir.iterdir()) if p.is_file()]
        return Run(r.stdout, r.returncode, r.stderr, [f for f in files if f[0].endswith(".prom")] if textfile else [],
                   [l for l in self.logf.read_text(encoding="utf-8").splitlines() if l.strip()])


class ScriptShape(unittest.TestCase):
    def test_file_shape(self):
        self.assertTrue(SCRIPT.is_file(), "missing infra/monitoring/textfile/container_health.sh")
        raw = SCRIPT.read_bytes()
        self.assertTrue(raw.startswith(b"#!/usr/bin/env bash") or raw.startswith(b"#!/bin/bash"))
        self.assertNotIn(b"\r\n", raw, "CRLF breaks bash")
        self.assertIn("set -u", raw.decode("utf-8"), "unset variables must not pass silently")
        r = subprocess.run([bash(), "-n", SCRIPT.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class ContainerHealth(_Env):
    def test_healthy_pdf_sandbox_is_1(self):  # done_when
        r = self.go(fleet())
        self.assertEqual(r.rc, 0, r.err[-500:])
        s = r.series()
        self.assertEqual(s["pdf-sandbox"], 1)
        self.assertEqual(s, {"pdf-sandbox": 1, "renderer": 1, "api-a": 1, "worker-a": 1})  # one series per compose service

    def test_unhealthy_and_starting_are_0_and_do_not_touch_others(self):  # 1 = healthcheck `healthy` only
        for status in ("unhealthy", "starting"):
            with self.subTest(status):
                r = self.go(fleet(**{"pdf-sandbox": C("lims-pdf-sandbox-1", "pdf-sandbox", health=status)}))
                self.assertEqual(r.rc, 0, r.err[-500:])
                s = r.series()
                self.assertEqual(s["pdf-sandbox"], 0)
                self.assertEqual((s["renderer"], s["api-a"], s["worker-a"]), (1, 1, 1))

    def test_stopped_container_is_never_1(self):  # exited with a stale `healthy` record; 0 or absent are both fine
        r = self.go(fleet(**{"pdf-sandbox": C("lims-pdf-sandbox-1", "pdf-sandbox", running=False, health="healthy")}))
        self.assertEqual(r.rc, 0, r.err[-500:])
        self.assertIn(r.series().get("pdf-sandbox", 0), (0,))

    def test_container_without_healthcheck_is_not_healthy_and_does_not_break_the_rest(self):
        r = self.go(fleet(**{"worker-a": C("lims-worker-a-1", "worker-a", health=None)}))
        self.assertEqual(r.rc, 0, "a container with no healthcheck must not abort the run: " + r.err[-500:])
        s = r.series()
        self.assertEqual(s.get("worker-a", 0), 0)
        self.assertEqual(s["pdf-sandbox"], 1)

    def test_replicas_collapse_to_one_series_that_needs_all_healthy(self):  # assumption: unspecified; Prometheus rejects dupes
        r = self.go(fleet(**{"renderer2": C("lims-renderer-2", "renderer", health="unhealthy", cid="b" * 64)}))
        self.assertEqual(r.rc, 0, r.err[-500:])
        self.assertEqual(r.series()["renderer"], 0)
        r = self.go(fleet(**{"renderer2": C("lims-renderer-2", "renderer", health="healthy", cid="b" * 64)}))
        self.assertEqual(r.series()["renderer"], 1)

    def test_state_flip_is_picked_up_by_the_next_run(self):  # 30 s cadence: the file is replaced, not appended to
        r = self.go(fleet(**{"pdf-sandbox": C("lims-pdf-sandbox-1", "pdf-sandbox", health="unhealthy")}))
        self.assertEqual(r.series()["pdf-sandbox"], 0)
        r = self.go(fleet())
        self.assertEqual(r.rc, 0, r.err[-500:])
        self.assertEqual(len(r.files), 1)
        self.assertEqual(r.series()["pdf-sandbox"], 1)

    def test_exposition_format(self):  # 02-TRD s11.1/s11.2: labels env/host/instance/service are added by C1 at scrape time; only {service}
        r = self.go(fleet())
        self.assertEqual(r.rc, 0, r.err[-500:])
        t = r.text
        self.assertRegex(t, r"(?m)^# TYPE %s gauge$" % METRIC)
        self.assertRegex(t, r"(?m)^# HELP %s .+" % METRIC)
        self.assertTrue(t.endswith("\n"), "text format needs a trailing newline")
        for l in r.samples:
            self.assertRegex(l, SAMPLE)
        self.assertNotRegex(t, r"[0-9a-f]{12}", "container ids must not appear in the output")
        self.assertNotIn("lims-pdf-sandbox-1", t, "container names must not appear in the output")
        self.assertEqual(len([l for l in t.splitlines() if l.startswith("# TYPE")]), 1)

    def test_atomic_single_prom_file_and_no_leftovers(self):
        r = self.go(fleet())
        self.assertEqual(r.rc, 0, r.err[-500:])
        names = sorted(p.name for p in self.outdir.iterdir())
        self.assertEqual(len(names), 1, "exactly one file expected in TEXTFILE_DIR, got %s" % names)
        self.assertTrue(names[0].endswith(".prom"), names)
        self.assertEqual(r.out.strip(), "", "nothing on stdout when TEXTFILE_DIR is set")

    def test_stdout_when_textfile_dir_unset(self):
        r = self.go(fleet(), textfile=False)
        self.assertEqual(r.rc, 0, r.err[-500:])
        self.assertEqual(r.series()["pdf-sandbox"], 1)
        self.assertEqual(list(self.outdir.iterdir()), [])

    def test_docker_down_fails_closed_and_leaves_no_healthy_sample(self):  # a stale `1` would hide a dead sandbox
        stale = "# TYPE %s gauge\n%s{service=\"pdf-sandbox\"} 1\n" % (METRIC, METRIC)
        r = self.go(fleet(), down=True, stale=stale)
        self.assertNotEqual(r.rc, 0, "unreadable docker must be a failure, not a healthy export")
        self.assertEqual(r.ones(), [], "stale/healthy sample survived: %r" % (r.files or r.out))

    def test_docker_down_to_stdout_prints_no_healthy_sample(self):
        r = self.go(fleet(), down=True, textfile=False)
        self.assertNotEqual(r.rc, 0)
        self.assertEqual(r.ones(), [])

    def test_read_only_docker_use(self):  # 02-TRD s11.1: read-only use of the Docker CLI
        r = self.go(fleet())
        self.assertEqual(r.rc, 0, r.err[-500:])
        self.assertTrue(r.log, "the script must read container state from docker")
        bad = r.docker_subcommands() - {"ps", "inspect", "container ls", "container list", "container ps", "container inspect",
                                         "info", "version"}
        self.assertEqual(bad, set(), "mutating/unsupported docker subcommands: %s" % sorted(bad))

    def test_untrusted_label_values_cannot_forge_or_alter_samples(self):  # trust boundary: docker labels
        evil = 'x"} 1\n%s{service="pdf-sandbox"} 1\n# ' % METRIC
        for label in (evil, 'a"b\\c', "sp ace\ttab", "ünï", ""):
            with self.subTest(label=label):
                r = self.go(fleet(**{"pdf-sandbox": C("lims-pdf-sandbox-1", "pdf-sandbox", health="unhealthy"),
                                     "evil": C("lims-evil-1", label or "ok", health="healthy", cid="c" * 64)}))
                for l in r.samples:
                    self.assertRegex(l, SAMPLE, "forged or malformed line: %r" % l)
                lines = r.samples
                self.assertEqual([l for l in lines if l.startswith(METRIC + '{service="pdf-sandbox"}')],
                                 [METRIC + '{service="pdf-sandbox"} 0'], "the real pdf-sandbox sample was forged/duplicated/lost")
                self.assertEqual(len(r.text.splitlines()), len(set(r.text.splitlines())), "duplicate lines")


class Scheduling(unittest.TestCase):
    """done_when needs the metric to actually be produced: 02-TRD s11.1 says every 30 s, by root on the host."""

    @staticmethod
    def files():
        return [p for p in ANSIBLE.rglob("*") if p.is_file() and p.suffix in (".yml", ".yaml", ".j2", ".timer", ".service", ".sh")]

    def test_script_is_installed_by_ansible(self):
        refs = [p for p in self.files() if "container_health.sh" in p.read_text(encoding="utf-8", errors="replace")]
        self.assertTrue(refs, "no Ansible file installs/references textfile/container_health.sh")

    def test_systemd_timer_every_30s_runs_it_into_the_node_exporter_textfile_dir(self):
        fs = self.files()
        timers = [p for p in fs if re.search(r"container[-_]health", p.name) and ".timer" in p.name]
        self.assertTrue(timers, "no container-health .timer (or .timer.j2) under infra/ansible")
        t = "\n".join(p.read_text(encoding="utf-8") for p in timers)
        self.assertRegex(t, r"(?m)(^\s*(OnUnitActiveSec|OnUnitInactiveSec)\s*=\s*30\s*(s|sec|seconds)?\s*$|"
                            r"^\s*OnCalendar\s*=.*\*:\*:(00?/30|0,30|00,30)\b)", "cadence must be 30 s")
        services = [p for p in fs if re.search(r"container[-_]health", p.name) and ".service" in p.name]
        self.assertTrue(services, "no container-health .service (or .service.j2)")
        s = "\n".join(p.read_text(encoding="utf-8") for p in services)
        self.assertIn("container_health.sh", s)
        self.assertIn("/var/lib/node_exporter/textfile", s)
        self.assertNotRegex(s, r"(?m)^\s*User\s*=\s*(?!root\b)\S+", "needs root for the docker CLI (02-TRD s11.1)")

    def test_no_docker_socket_mounted_into_any_app_container(self):  # 02-TRD s11.1
        text = (ROOT / "infra" / "compose" / "lims" / "compose.app.yml").read_text(encoding="utf-8")
        self.assertNotIn("docker.sock", text)


if __name__ == "__main__":
    unittest.main()
