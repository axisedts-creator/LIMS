"""T-26 tests (tester role): Studio / pg-meta break-glass playbook + compose override.

Covers 02-TRD s7.10 (+s3.3, s7.2), 03-APP-FLOW s9, 04-UI-UX s5 (`-e action=enable -e hours=2 -e approval=<ref>`),
AC-06.3 (also AC-06.2 as the "back to baseline" half), 07-SEC REQ-SEC-037 / row AB-12 (<= 4 h timer, hourly alert) and
the "Studio uses BYPASSRLS postgres -> founder approval recorded in ops_audit" control. LD-45: group names only.
Done when (T-26): enable/disable with timer, password rotation, alert, ops_audit; the override publishes 127.0.0.1:8000
for the gateway only while enabled (via `breakglass_net`) and removes it on disable.

NOT provable here (no ansible, no Docker daemon, no systemd): a real enable/disable run on a dev VM, a real Envoy
answering on 127.0.0.1:8000, real timer expiry. These tests prove the committed artefacts: the override really renders
(`docker compose config`, needs the CLI only), and the playbook's structure, validation matrix (evaluated with Jinja2),
ordering, secret hygiene and fail-closed behaviour.

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ansible/playbooks/studio-breakglass.yml: YAML list of plays, every play `hosts: app`, `become: true`; no literal
   host names; cites LD-45. Inputs are extra-vars `action` (enable|disable), `hours` (enable only, integer 1..4, int or
   numeric string), `approval` (enable only, non-blank). `ansible.builtin.assert` tasks reject anything else BEFORE the
   first state change (the validation expressions are evaluated here with plain Jinja2 + the `match`/`search` tests
   + a `bool` filter, so keep them to that); disable needs neither `hours` nor `approval` (the timer calls it).
 * Compose files in every command: -f upstream/docker-compose.yml -f override.app.yml [-f override.breakglass.yml], project
   `supabase`, env file /run/lims/env/supabase.env. ENABLE: rotate DASHBOARD_PASSWORD first, then one or more commands with
   the break-glass file that together name api-gw studio meta and --force-recreate (gateway recreated so it picks up the new
   password, the studio routes and the loopback port). DISABLE: a command WITH the break-glass file that removes/stops
   studio meta (the app layer `!reset`s them, so they only exist with the override), then api-gw `--force-recreate` WITHOUT
   the break-glass file (back to the trimmed config, no port), `breakglass_net` removed, rotate the password again, timer off.
 * Timer: unit name starts `lims-studio-breakglass`; absolute `OnCalendar` computed from `{{ hours }}`, `Persistent=true`
   (a reboot inside the window must still end break-glass), an ExecStart/systemd-run that performs the disable.
 * Rotation: tasks that touch DASHBOARD_PASSWORD carry `no_log: true` (own or block level), never put the value on a
   command line, the file compose reads (/run/lims/env/supabase.env) is not world-readable, >= 32 random chars,
   rotation applies for BOTH actions. No `debug` task may print it.
 * ops_audit: >= 2 `infra/ci/ops-note.sh` calls via `ansible.builtin.command` + `argv` (never a shell string; the approval ref
   is untrusted text); the enable note carries approval and hours, the disable note says disable; the password is never in a note.
 * Metric: textfile `lims_ops_studio_enabled` (1 on enable, 0 on disable) in /var/lib/node_exporter/textfile.
 * Fail closed: the state-changing part of enable sits in a `block:` whose `rescue:` stops studio+meta, recreates api-gw
   without the override and ends with ansible.builtin.fail.
 * override.breakglass.yml: gateway ports == exactly 127.0.0.1:8000->8000/tcp; gateway also on app_net+auth_net+
   `breakglass_net` (non-internal, name breakglass_net); studio and meta NOT on breakglass_net, no ports; gateway mounts the
   full (studio-bearing) Envoy lds/cds, not the trimmed copies; studio/meta digest-pinned, mem_limit, pids_limit,
   restart "no" or "on-failure" (a reboot must not resurrect Studio); meta reaches Postgres on db_net at POSTGRES_HOST.
 * AC-06.3 "alert every hour": alertmanager.yml.j2 needs a route for alertname="StudioEnabled" with repeat_interval: 1h
   before the generic severity="info" route (T-18/T-19 file; if the writer may not touch it -> CR/dispute).
Stdlib + PyYAML + Jinja2. Missing file = FAIL (never skip). Needs the docker CLI (compose >= 2.24.4), no daemon.
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t26_*.py" -v
"""
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOK = ROOT / "infra" / "ansible" / "playbooks" / "studio-breakglass.yml"
SUPA = ROOT / "infra" / "compose" / "supabase"
UP = SUPA / "upstream"
OVERRIDE = SUPA / "override.breakglass.yml"
ALERTMANAGER = ROOT / "infra" / "monitoring" / "alertmanager" / "alertmanager.yml.j2"

HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|dev-1)\b")
DATA_WG, APP_WG, DASH_PW = "10.79.0.11", "10.79.0.12", "sentinel-dashboard-pw"
KEYWORDS = {
    "name", "when", "register", "no_log", "become", "become_user", "vars", "loop", "with_items", "loop_control",
    "delegate_to", "changed_when", "failed_when", "tags", "notify", "args", "environment", "ignore_errors", "retries",
    "delay", "until", "check_mode", "run_once", "any_errors_fatal", "throttle", "timeout", "diff", "listen",
}


def read(p):
    if not p.is_file():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p.read_text(encoding="utf-8")


# ----------------------------------------------------------------------------------------------------- playbook model
def as_list(v):
    return [] if v is None else (v if isinstance(v, list) else [v])


def load_plays():
    plays = yaml.safe_load(read(PLAYBOOK))
    if not isinstance(plays, list) or not plays or not all(isinstance(p, dict) for p in plays):
        raise AssertionError("playbook must be a non-empty YAML list of plays")
    return plays


def walk(tasks, section="main", when=(), nolog=False):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        if any(k in t for k in ("block", "rescue", "always")):
            w = when + tuple(as_list(t.get("when")))
            nl = nolog or bool(t.get("no_log"))
            for key in ("block", "rescue", "always"):
                sec = "rescue" if key == "rescue" else section
                yield from walk(t.get(key), sec, w, nl)
        else:
            yield {"task": t, "section": section, "when": when + tuple(as_list(t.get("when"))),
                   "no_log": nolog or bool(t.get("no_log")), "text": json.dumps(t, default=str)}


def entries():
    out = []
    for p in load_plays():
        for key in ("pre_tasks", "tasks", "post_tasks"):
            out += list(walk(p.get(key)))
    for i, e in enumerate(out):
        e["i"] = i
    return out


def module(task):
    for k in task:
        if k not in KEYWORDS:
            return k.split(".")[-1]
    return ""


_J = jinja2.Environment(undefined=jinja2.Undefined)
_J.tests["match"] = lambda v, p: re.match(p, str(v)) is not None
_J.tests["search"] = lambda v, p: re.search(p, str(v)) is not None
_J.tests["regex"] = lambda v, p: re.search(p, str(v)) is not None
_J.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")


def ev(expr, ctx):
    return _J.compile_expression(str(expr))(**ctx)


def applies(entry, action):
    """A `when` condition that mentions `action` is evaluated; any other condition (registered vars...) is assumed true."""
    for c in entry["when"]:
        if "action" not in str(c):
            continue
        try:
            if not ev(c, {"action": action}):
                return False
        except Exception:
            pass
    return True


def on(action, *, rescue=False):
    return [e for e in entries() if applies(e, action) and (e["section"] == "rescue") == rescue]


def joined(es):
    return "\n".join(e["text"] for e in es)


class PlaybookShape(unittest.TestCase):
    def test_plays_target_app_with_become(self):
        for p in load_plays():
            self.assertEqual(p.get("hosts"), "app", "every play must run on group `app` only (LD-45)")
            self.assertTrue(p.get("become"), "become: true required")

    def test_no_host_names_and_cites_ld45(self):
        text = read(PLAYBOOK)
        self.assertIsNone(HOSTNAMES.search(text), "literal host name in playbook")
        self.assertIn("LD-45", text)


class Validation(unittest.TestCase):
    """Evaluate every assert the playbook has (before any state change) for a matrix of inputs."""

    def verdict(self, **ctx):
        asserts = [e for e in entries() if module(e["task"]) == "assert"]
        self.assertTrue(asserts, "no ansible.builtin.assert validation task")
        for e in asserts:
            skip = False
            for c in e["when"]:
                try:
                    skip = skip or not ev(c, ctx)
                except Exception:
                    pass
            if skip:
                continue
            that = as_list((e["task"][next(k for k in e["task"] if k.endswith("assert"))] or {}).get("that"))
            for expr in that:
                try:
                    if not ev(expr, ctx):
                        return False
                except Exception:
                    return False
        return True

    def test_valid_enable_accepted(self):
        for h in (1, 2, 4, "1", "2", "4"):
            self.assertTrue(self.verdict(action="enable", hours=h, approval="CHG-123 founder 2026-11-08"), h)

    def test_hours_out_of_range_or_not_integer_rejected(self):
        for h in (0, 5, 24, 99, -1, "0", "5", "abc", "", "4h", "2.5", 2.5, 4.5, "1e1", " ", None):
            ctx = dict(action="enable", approval="CHG-123")
            if h is not None:
                ctx["hours"] = h
            self.assertFalse(self.verdict(**ctx), "hours=%r must be rejected (cap 4 h, AB-12)" % (h,))

    def test_approval_required_for_enable(self):
        for a in (None, "", "   "):
            ctx = dict(action="enable", hours=2)
            if a is not None:
                ctx["approval"] = a
            self.assertFalse(self.verdict(**ctx), "approval=%r must be rejected (founder approval, 04 D5)" % (a,))

    def test_bad_action_rejected(self):
        for a in (None, "", "restart", "Enable", "enable ", "start", "enable;disable"):
            ctx = dict(hours=2, approval="CHG-123")
            if a is not None:
                ctx["action"] = a
            self.assertFalse(self.verdict(**ctx), "action=%r must be rejected" % (a,))

    def test_disable_needs_neither_hours_nor_approval(self):
        self.assertTrue(self.verdict(action="disable"))

    def test_validation_precedes_every_state_change(self):
        es = entries()
        first_assert = min((e["i"] for e in es if module(e["task"]) == "assert"), default=None)
        self.assertIsNotNone(first_assert, "no assert task")
        change = [e["i"] for e in es if re.search(r"override\.breakglass|DASHBOARD_PASSWORD|systemd|lims-studio-breakglass|ops-note",
                                                     e["text"]) and module(e["task"]) != "assert"]
        self.assertTrue(change, "no state-changing task found")
        self.assertLess(first_assert, min(change), "state change before validation")


class EnableDisable(unittest.TestCase):
    def test_enable_starts_gateway_studio_meta_with_override(self):
        es = [e for e in on("enable") if "override.breakglass.yml" in e["text"]]
        self.assertTrue(es, "no enable-path command uses override.breakglass.yml")
        t = joined(es)
        for w in ("api-gw", "studio", "meta", "force-recreate", "override.app.yml"):
            self.assertIn(w, t, "enable path: %s missing from the break-glass compose commands" % w)

    def test_enable_uses_the_rendered_env_file_not_defaults(self):
        self.assertIn("/run/lims/env/supabase.env", joined(on("enable")))

    def test_enable_rotates_password_before_bringing_gateway_up(self):
        en = on("enable")
        rot = [e["i"] for e in en if "DASHBOARD_PASSWORD" in e["text"]]
        up = [e["i"] for e in en if "override.breakglass.yml" in e["text"] and re.search(r"\bup\b", e["text"])]
        self.assertTrue(rot, "enable never touches DASHBOARD_PASSWORD")
        self.assertTrue(up, "enable never runs `up` with the override")
        self.assertLess(min(rot), min(up), "gateway would start with the old password")

    def test_disable_removes_studio_and_meta(self):
        es = [e for e in on("disable") if "override.breakglass.yml" in e["text"] and "studio" in e["text"] and "meta" in e["text"]]
        self.assertTrue(es, "disable must address studio+meta with the override file (they only exist with it)")
        self.assertTrue(any(re.search(r"\b(rm|stop|down|kill)\b|absent", e["text"]) for e in es), "disable never stops/removes them")

    def test_disable_recreates_gateway_without_override(self):
        es = [e for e in on("disable") if "api-gw" in e["text"] and "force-recreate" in e["text"]]
        self.assertTrue(es, "disable must `--force-recreate api-gw` to drop the published port")
        for e in es:
            self.assertNotIn("override.breakglass.yml", e["text"], "recreated WITH the override: port stays published")
            self.assertIn("override.app.yml", e["text"])

    def test_disable_removes_temporary_network(self):
        es = [e for e in on("disable") if "breakglass_net" in e["text"]]
        self.assertTrue(es, "breakglass_net is temporary: disable must remove it")
        self.assertTrue(any(re.search(r"\b(rm|remove|down)\b|absent", e["text"]) for e in es))

    def test_disable_does_not_need_the_enable_inputs(self):
        # a task that references hours/approval must not run on disable (the timer calls disable without them)
        for e in on("disable"):
            if module(e["task"]) in ("assert", "fail"):
                continue
            self.assertNotRegex(e["text"], r"\{\{[^}]*\b(approval)\b", "disable-path task needs `approval`: %s" % e["task"].get("name"))


class Timer(unittest.TestCase):
    def test_timer_is_absolute_persistent_and_derived_from_hours(self):
        es = [e for e in on("enable") if "lims-studio-breakglass" in e["text"]]
        self.assertTrue(es, "no timer (lims-studio-breakglass*) created on enable")
        t = joined(es)
        self.assertRegex(t, r"OnCalendar|on-calendar", "must be an absolute time (a reboot resets a monotonic timer)")
        self.assertRegex(t, r"(?i)persistent\W+(true|yes|1)", "Persistent=true: a reboot inside the window must still end break-glass")
        self.assertRegex(t, r"\{\{[^}]*\bhours\b[^}]*\}\}", "timer time must come from {{ hours }}")
        self.assertRegex(t, r"ExecStart|systemd-run", "timer has no action")

    def test_timer_started_on_enable_and_removed_on_disable(self):
        en = joined([e for e in on("enable") if "lims-studio-breakglass" in e["text"]])
        self.assertRegex(en, r"(?i)\"(started|restarted)\"|enable --now|start ", "timer never started")
        di = [e for e in on("disable") if "lims-studio-breakglass" in e["text"]]
        self.assertTrue(di, "disable leaves the timer in place")
        self.assertRegex(joined(di), r"absent|stopped|disable|stop ", "timer not stopped/removed on disable")


class PasswordRotation(unittest.TestCase):
    def rotation(self):
        return [e for e in entries() if "DASHBOARD_PASSWORD" in e["text"]]

    def test_rotation_on_enable_and_on_disable(self):
        r = self.rotation()
        self.assertTrue(r, "no DASHBOARD_PASSWORD rotation at all")
        for a in ("enable", "disable"):
            self.assertTrue([e for e in r if applies(e, a) and e["section"] != "rescue"],
                            "no DASHBOARD_PASSWORD rotation on %s (03-APP-FLOW s9)" % a)

    def test_no_log_on_every_task_touching_the_password(self):
        for e in self.rotation():
            self.assertTrue(e["no_log"], "task leaks DASHBOARD_PASSWORD into the log (needs no_log): %s" % e["task"].get("name"))

    def test_never_on_a_command_line_or_printed(self):
        for e in self.rotation():
            m = module(e["task"])
            self.assertNotEqual(m, "debug", "debug task prints the password")
            if m in ("command", "shell", "raw", "script"):
                self.assertNotRegex(e["text"], r"DASHBOARD_PASSWORD[^\"]{0,12}\{\{", "password value on a command line")

    def test_env_file_not_world_readable(self):
        es = [e for e in entries() if "/run/lims/env/supabase.env" in e["text"] and module(e["task"]) in
              ("lineinfile", "copy", "template", "file", "replace", "blockinfile")]
        self.assertTrue(es, "the new password never reaches /run/lims/env/supabase.env (what compose reads)")
        for e in es:
            args = list(e["task"].values())
            modes = [str(a.get("mode")) for a in args if isinstance(a, dict) and a.get("mode") is not None]
            for md in modes:
                self.assertRegex(md, r"^0?[0-7][0-7]0$", "mode %s lets others read the secret" % md)

    def test_password_is_strong(self):
        t = joined(self.rotation()) + "\n" + joined(entries())
        ok = (re.search(r"length\W{1,4}(\d+)", t) and int(re.search(r"length\W{1,4}(\d+)", t).group(1)) >= 32) \
            or re.search(r"openssl rand\s+-hex\s+(\d+)", t) and int(re.search(r"openssl rand\s+-hex\s+(\d+)", t).group(1)) >= 16 \
            or re.search(r"openssl rand\s+-base64\s+(\d+)", t) and int(re.search(r"openssl rand\s+-base64\s+(\d+)", t).group(1)) >= 24
        self.assertTrue(ok, "no visible generator for >= 32 random characters")


class OpsAudit(unittest.TestCase):
    def notes(self):
        return [e for e in entries() if "ops-note" in e["text"]]

    def test_enable_and_disable_are_recorded(self):
        n = self.notes()
        self.assertGreaterEqual(len(n), 2, "enable and disable each need an ops_audit note")
        en = [e for e in n if applies(e, "enable") and "enable" in e["text"].lower()]
        di = [e for e in n if applies(e, "disable") and "disable" in e["text"].lower()]
        self.assertTrue(en, "no enable note")
        self.assertTrue(di, "no disable note")
        self.assertTrue(any("approval" in e["text"] and "hours" in e["text"] for e in en), "enable note must carry approval and hours")

    def test_notes_use_argv_not_a_shell_string(self):
        for e in self.notes():
            self.assertEqual(module(e["task"]), "command", "ops-note via %s" % module(e["task"]))
            body = e["task"][next(k for k in e["task"] if k.endswith("command"))]
            self.assertTrue(isinstance(body, dict) and "argv" in body, "ops-note must use argv (approval ref is untrusted text)")

    def test_password_never_in_a_note(self):
        for e in self.notes():
            self.assertNotRegex(e["text"], r"(?i)dashboard_password|new_password|\bpassword\b.*\{\{")

    def test_untrusted_inputs_never_reach_a_shell_string(self):
        for e in entries():
            m = module(e["task"])
            body = e["task"].get(next((k for k in e["task"] if k.split(".")[-1] == m), ""), "")
            freeform = m in ("shell", "raw", "script") or (m == "command" and not (isinstance(body, dict) and "argv" in body))
            if freeform:
                self.assertNotRegex(e["text"], r"\{\{[^}]*\b(approval|action)\b", "approval/action interpolated into a shell string")


class MetricAndFailClosed(unittest.TestCase):
    def test_textfile_metric_set_on_enable_and_cleared_on_disable(self):
        es = [e for e in entries() if "lims_ops_studio_enabled" in e["text"]]
        self.assertTrue(es, "playbook never writes lims_ops_studio_enabled (alert StudioEnabled depends on it)")
        for a in ("enable", "disable"):
            self.assertTrue([e for e in es if applies(e, a)], "metric not written on %s" % a)
        self.assertIn("/var/lib/node_exporter/textfile", joined(es))

    def test_failed_enable_rescue_stops_studio_and_fails(self):
        resc = [e for e in entries() if e["section"] == "rescue"]
        self.assertTrue(resc, "no rescue: a half-failed enable would leave Studio running")
        t = joined(resc)
        self.assertRegex(t, r"studio")
        self.assertRegex(t, r"meta")
        self.assertRegex(t, r"\b(rm|stop|down)\b|absent")
        gw = [e for e in resc if "api-gw" in e["text"] and "force-recreate" in e["text"]]
        self.assertTrue(gw, "rescue must recreate api-gw to drop the published port")
        for e in gw:
            self.assertNotIn("override.breakglass.yml", e["text"])
        self.assertEqual(module(resc[-1]["task"]), "fail", "rescue must end with ansible.builtin.fail (a failed enable never exits 0)")


# -------------------------------------------------------------------------------------------- compose (docker config)
def env_for(files):
    env = {}
    ex = UP / ".env.example"
    if ex.is_file():
        for line in ex.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
            if m:
                env[m.group(1)] = m.group(2)
    env.update({"WG_IP": APP_WG, "POSTGRES_HOST": DATA_WG, "SMTP_HOST": "10.79.0.99", "SMTP_PORT": "587",
                "DASHBOARD_PASSWORD": DASH_PW})
    for rel in files:
        for m in re.finditer(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?\?[^}]*)?\}", (SUPA / rel).read_text(encoding="utf-8")):
            env.setdefault(m.group(1), "8000" if m.group(1).endswith("PORT") else "x")
    return env


_cfg = {}


def compose(files):
    key = tuple(files)
    if key in _cfg:
        return _cfg[key]
    for f in files:
        if not (SUPA / f).is_file():
            raise AssertionError("missing file infra/compose/supabase/%s" % f)
    try:
        v = subprocess.run(["docker", "compose", "version", "--short"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise AssertionError("docker CLI required: %s" % e)
    if v.returncode:
        raise AssertionError("docker compose unavailable: %s" % v.stderr)
    with tempfile.TemporaryDirectory() as td:
        ef = Path(td) / "env"
        ef.write_text("".join("%s=%s\n" % kv for kv in env_for(files).items()), encoding="utf-8")
        cmd = ["docker", "compose", "--project-directory", str(SUPA), "-p", "supabase", "--env-file", str(ef)]
        for f in files:
            cmd += ["-f", str(SUPA / f)]
        r = subprocess.run(cmd + ["config", "--format", "json"], capture_output=True, text=True, timeout=120)
    if r.returncode:
        raise AssertionError("docker compose config failed:\n%s" % r.stderr.strip()[-1500:])
    _cfg[key] = json.loads(r.stdout)
    return _cfg[key]


BASE = ["upstream/docker-compose.yml", "override.app.yml"]
BG = BASE + ["override.breakglass.yml"]


def nets(svc):
    n = svc.get("networks") or {}
    return set(n.keys()) if isinstance(n, dict) else set(n)


class Override(unittest.TestCase):
    def svc(self, name, files=BG):
        s = compose(files)["services"]
        self.assertIn(name, s, "service %s missing from the break-glass layering" % name)
        return s[name]

    def test_renders_with_the_app_layers(self):
        c = compose(BG)
        for n in ("api-gw", "studio", "meta"):
            self.assertIn(n, c["services"])

    def test_baseline_has_no_port_no_studio_no_breakglass_net(self):  # what disable returns to (AC-06.2)
        c = compose(BASE)
        self.assertFalse(c["services"]["api-gw"].get("ports"))
        self.assertNotIn("studio", c["services"])
        self.assertNotIn("meta", c["services"])
        self.assertNotIn("breakglass_net", c.get("networks", {}))
        self.assertNotIn("breakglass_net", nets(c["services"]["api-gw"]))

    def test_gateway_publishes_exactly_loopback_8000(self):
        ports = self.svc("api-gw").get("ports") or []
        self.assertEqual(len(ports), 1, ports)
        p = ports[0]
        self.assertEqual((p.get("host_ip"), int(p.get("published")), int(p.get("target")), p.get("protocol", "tcp")),
                         ("127.0.0.1", 8000, 8000, "tcp"))

    def test_nothing_else_publishes_a_port(self):
        for n, s in compose(BG)["services"].items():
            if n != "api-gw":
                self.assertFalse(s.get("ports"), "%s publishes %s" % (n, s.get("ports")))
            self.assertNotEqual(s.get("network_mode"), "host", n)

    def test_override_text_has_no_wildcard_or_wg_publish(self):
        t = read(OVERRIDE)
        # ruling C1.T-26: only host port publishing is constrained; container-internal listen addrs (HOSTNAME: 0.0.0.0) are fine
        self.assertNotRegex(t, r"(?m)^\s*-?\s*[\"']?0\.0\.0\.0:\d+")
        for n, s in compose(BG)["services"].items():
            for p in s.get("ports") or []:
                if isinstance(p, dict):
                    self.assertNotIn(p.get("host_ip"), (None, "", "0.0.0.0"), "%s publishes on wildcard: %s" % (n, p))
                else:
                    self.assertFalse(str(p).startswith("0.0.0.0:"), "%s publishes on wildcard: %s" % (n, p))
        self.assertNotRegex(t, r"\$\{WG_IP\}:8000")
        self.assertIn("breakglass_net", t)

    def test_gateway_networks(self):
        c = compose(BG)
        self.assertTrue({"app_net", "auth_net", "breakglass_net"} <= nets(c["services"]["api-gw"]))
        bn = c["networks"]["breakglass_net"]
        self.assertEqual(bn.get("name"), "breakglass_net")
        self.assertFalse(bn.get("internal", False), "breakglass_net must be non-internal or Docker will not publish the port")
        for n in ("app_net", "auth_net"):
            self.assertTrue(c["networks"][n].get("internal"), "%s must stay internal" % n)

    def test_studio_and_meta_are_not_on_the_breakglass_net(self):
        for n in ("studio", "meta"):
            self.assertNotIn("breakglass_net", nets(self.svc(n)), "%s must not be reachable from the published network" % n)

    def test_studio_reachable_from_gateway_and_meta_reaches_postgres(self):
        gw, st, me = nets(self.svc("api-gw")), nets(self.svc("studio")), nets(self.svc("meta"))
        self.assertTrue((gw - {"breakglass_net"}) & st, "gateway cannot reach studio")
        self.assertTrue(st & me, "studio cannot reach meta")
        self.assertIn("db_net", me, "meta cannot reach Postgres")

    def test_studio_and_meta_wiring(self):
        st, me = self.svc("studio")["environment"], self.svc("meta")["environment"]
        self.assertEqual(st.get("STUDIO_PG_META_URL"), "http://meta:8080")
        self.assertEqual(st.get("SUPABASE_URL"), "http://api-gw:8000")
        self.assertEqual(st.get("POSTGRES_HOST"), DATA_WG)
        self.assertEqual(me.get("PG_META_DB_HOST"), DATA_WG)

    def test_studio_meta_start_set_is_closed(self):
        s = compose(BG)["services"]
        seen, todo = set(), ["studio", "meta"]
        while todo:
            n = todo.pop()
            if n not in seen:
                seen.add(n)
                todo += list((s[n].get("depends_on") or {}).keys())
        self.assertTrue(seen <= {"studio", "meta", "api-gw"}, "starting studio+meta would also start %s" % (seen - {"studio", "meta", "api-gw"}))

    def test_gateway_mounts_the_full_envoy_config_with_studio(self):
        vols = {v["target"]: v.get("source", "") for v in self.svc("api-gw").get("volumes", [])}
        lds, cds = vols.get("/etc/envoy/lds.template.yaml"), vols.get("/etc/envoy/cds.yaml")
        self.assertTrue(lds and cds, "gateway lost its envoy mounts: %s" % vols)
        ltext, ctext = Path(lds).read_text(encoding="utf-8"), Path(cds).read_text(encoding="utf-8")
        self.assertIn("cluster: studio", ltext, "gateway has no route to studio (trimmed config still mounted)")
        self.assertIn("${DASHBOARD_BASIC_AUTH}", ltext, "studio would be served without basic auth")
        self.assertRegex(ctext, r"name: studio")

    def test_dashboard_password_comes_from_env_not_the_file(self):
        self.assertEqual(self.svc("api-gw")["environment"].get("DASHBOARD_PASSWORD"), DASH_PW)
        self.assertNotRegex(read(OVERRIDE), r"DASHBOARD_PASSWORD\s*:\s*(?!\$\{)\S")

    def test_studio_and_meta_hardened(self):
        for n in ("studio", "meta"):
            s = self.svc(n)
            self.assertRegex(s.get("image", ""), r"@sha256:[0-9a-f]{64}$", "%s image not digest-pinned" % n)
            self.assertTrue(s.get("mem_limit"), "%s has no mem_limit" % n)
            self.assertTrue(s.get("pids_limit"), "%s has no pids_limit" % n)
            self.assertIn(s.get("restart"), ("no", "on-failure"), "%s would come back after a reboot, past the timer" % n)
        self.assertTrue(self.svc("studio")["image"].startswith("supabase/studio"))
        self.assertTrue(self.svc("meta")["image"].startswith("supabase/postgres-meta"))


class AlertWiring(unittest.TestCase):
    def test_studio_enabled_repeats_hourly(self):  # AC-06.3 "every hour"
        t = read(ALERTMANAGER)
        m = re.search(r"- matchers: \[[^\n]*alertname=\"StudioEnabled\"[^\n]*\]\n((?:\s{6,}[^\n]*\n)*)", t)
        self.assertIsNotNone(m, "no alertmanager route for alertname=\"StudioEnabled\"")
        self.assertRegex(m.group(1), r"repeat_interval:\s*1h\b")
        self.assertLess(m.start(), t.index("severity=\"info\""), "route must come before the generic severity=info route")


if __name__ == "__main__":
    unittest.main()
