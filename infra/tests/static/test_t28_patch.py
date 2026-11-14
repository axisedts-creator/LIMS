"""T-28 tests (tester role): patching playbook + patch metric + runbook (AC-16.1, AC-16.2).

Covers 06-PLAN row T-28 (done_when: monthly flow dev->staging->prod in dry-run; emergency path; tests: PatchOverdue promtool
test), 02-TRD s13 (patching) + s9/s11 textfile + s15 alert row `PatchOverdue`, 04-UI-UX s4 (`patching.md`: monthly +
emergency procedure; patch log table), 07-SECURITY REQ-SEC-129/138 (monthly patching, critical 72 h).
LD-45: group names only in patch.yml (no literal host names); the playbook cites LD-45; both profiles run the same plays.

NOT provable here (no ansible, apt, docker, promtool): a real or --check run, a real reboot, `promtool test rules`.
These tests prove the committed artefacts: structure, the env-order/soak guard matrix (Jinja2), ordering, the metric
script against a fake state dir, the timer, the runbook. Live dry-run: infra/tests/integration/test_t28_live.py (LIMS_T28_LIVE=1).

CONTRACTS where the spec is silent (the writer meets them; ambiguity -> dispute, not a silent change):
 * infra/ansible/playbooks/patch.yml: YAML list of plays; each play `hosts` in {localhost, all, ops, data, app, dr, backup};
   every non-localhost play `become: true`. One environment per run (`-i inventories/<env>`; `env` comes from group_vars).
   The order dev -> staging -> prod is enforced by GUARDS (assert/fail) that run BEFORE the first state change, using
   extra-vars: `patch_previous_done_at` (epoch seconds of the previous environment's successful patch run, int or numeric
   string; `-e` values arrive as strings) and `patch_emergency` (bool, default false; this is the "--emergency" of 02-TRD s13).
   The guards compare with a fact `patch_now_epoch` (the playbook sets it with set_fact from a clock before the guards; the
   tests supply it). Rules: env must be dev|staging|prod. dev: no evidence needed. staging: needs patch_previous_done_at,
   positive and not in the future. prod: the same, and (non-emergency) at least 86400 s old = the 24 h soak [CONV];
   with patch_emergency the soak is skipped but the evidence is still required (02-TRD s13: "keeps staging smoke").
 * Flow: apt update + upgrade (ansible.builtin.apt with `upgrade:`), a reboot only when /var/run/reboot-required exists
   (stat result gates ansible.builtin.reboot), then ONE stamp per host: /var/lib/lims/patch/last_patch_timestamp holding epoch
   seconds, written only after upgrade + reboot, never `check_mode: false` (a dry run must not refresh the metric). Host
   plays use `serial` (never the whole fleet at once) and `any_errors_fatal: true`. The upgrade is never skipped by
   patch_emergency (an emergency still patches). No ignore_errors on upgrade/reboot/stamp. No floating `:latest`, no `--force-yes`.
 * infra/monitoring/textfile/patch_metrics.sh: bash, LF, `set -u`; reads STATE_DIR (default /var/lib/lims/patch) file
   last_patch_timestamp; writes ONE gauge `lims_ops_last_patch_timestamp_seconds <epoch>` with NO labels (the scrape adds
   `host`, prometheus.yml.j2) atomically to $TEXTFILE_DIR/patch.prom (stdout when unset). Fail closed: missing, empty,
   non-integer, <= 0 or future (> now + 300 s) stamp -> exit != 0 and no sample with a positive value survives (a stale
   .prom is removed or rewritten without one); the stamp text is never evaluated. Timer + service under infra/ansible run it as
   root with TEXTFILE_DIR=/var/lib/node_exporter/textfile.
 * infra/runbooks/patching.md: level-2 headings (GitHub slugs) monthly-window, emergency-patch, kernel-reboots, patch-log,
   dry-run; the patch log is a Markdown table (append via PR). Content checks in RunbookContent.
 * PatchOverdue itself (T-19) lives in monitoring/rules/host.rules.yml + tests/host_slow.test.yml; pinned here because T-28
   names it as the task's test.
Stdlib + PyYAML + Jinja2. Missing file = FAIL (never skip). Run from repo root:
  python -B -m unittest discover -s infra/tests/static -p "test_t28_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOK = ROOT / "infra" / "ansible" / "playbooks" / "patch.yml"
SCRIPT = ROOT / "infra" / "monitoring" / "textfile" / "patch_metrics.sh"
RUNBOOK = ROOT / "infra" / "runbooks" / "patching.md"
RULES = ROOT / "infra" / "monitoring" / "rules" / "host.rules.yml"
RULE_TESTS = ROOT / "infra" / "monitoring" / "rules" / "tests" / "host_slow.test.yml"
ANSIBLE = ROOT / "infra" / "ansible"
METRIC = "lims_ops_last_patch_timestamp_seconds"

HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|staging-a|staging-b|dev-1)\b")
KEYWORDS = {
    "name", "when", "register", "no_log", "become", "become_user", "vars", "loop", "with_items", "loop_control",
    "delegate_to", "changed_when", "failed_when", "tags", "notify", "args", "environment", "ignore_errors", "retries",
    "delay", "until", "check_mode", "run_once", "any_errors_fatal", "throttle", "timeout", "diff", "listen",
    "async", "poll",
}
NOW = 1_800_000_000
DAY = 86400


def read(p):
    if not p.is_file():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p.read_text(encoding="utf-8")


def as_list(v):
    return [] if v is None else (v if isinstance(v, list) else [v])


def load_plays():
    plays = yaml.safe_load(read(PLAYBOOK))
    if not isinstance(plays, list) or not plays or not all(isinstance(p, dict) for p in plays):
        raise AssertionError("playbook must be a non-empty YAML list of plays")
    return plays


def walk(tasks, section="main", when=(), play=0):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        if any(k in t for k in ("block", "rescue", "always")):
            w = when + tuple(as_list(t.get("when")))
            for key in ("block", "rescue", "always"):
                yield from walk(t.get(key), "rescue" if key == "rescue" else section, w, play)
        else:
            yield {"task": t, "section": section, "when": when + tuple(as_list(t.get("when"))),
                   "text": json.dumps(t, default=str), "play": play}


def entries():
    out = []
    for n, p in enumerate(load_plays()):
        for key in ("pre_tasks", "tasks", "post_tasks"):
            out += list(walk(p.get(key), play=n))
    for i, e in enumerate(out):
        e["i"] = i
    return out


def module(task):
    for k in task:
        if k not in KEYWORDS:
            return k.split(".")[-1]
    return ""


def args_of(task):
    for k, v in task.items():
        if k not in KEYWORDS:
            return v if isinstance(v, dict) else {"_raw_params": v}
    return {}


_J = jinja2.Environment(undefined=jinja2.Undefined)
for _n in ("match", "search", "regex"):
    _J.tests[_n] = (lambda f: (lambda v, p: f(p, str(v)) is not None))(re.match if _n == "match" else re.search)
_J.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")


def ev(expr, ctx):
    return _J.compile_expression(str(expr))(**ctx)


CHANGING = ("apt", "reboot", "copy", "command", "shell", "file", "lineinfile", "template", "systemd", "service")


def first_change_index():
    for e in entries():
        if module(e["task"]) not in ("assert", "fail", "set_fact", "stat", "include_vars", "slurp", "meta", "debug", "ping"):
            return e["i"]
    return len(entries())


def find(pattern, es=None, flags=re.I):
    return [e for e in (es if es is not None else entries()) if re.search(pattern, e["text"], flags)]


def upgrade_tasks():
    return [e for e in entries() if module(e["task"]) == "apt" and "upgrade" in args_of(e["task"])]


class PlaybookShape(unittest.TestCase):
    def test_plays_use_group_names_with_become(self):
        for p in load_plays():
            self.assertIn(p.get("hosts"), ("localhost", "all", "ops", "data", "app", "dr", "backup"), "group names only (LD-45)")
            if p.get("hosts") != "localhost":
                self.assertTrue(p.get("become"), "become: true required on host plays")

    def test_no_host_names_and_cites_ld45(self):
        text = read(PLAYBOOK)
        self.assertIsNone(HOSTNAMES.search(text), "literal host name in playbook")
        self.assertIn("LD-45", text)

    def test_header_cites_the_spec_and_emergency_var(self):
        text = read(PLAYBOOK)
        self.assertIn("patch_emergency", text)
        self.assertRegex(text, r"s13|section 13|§13|02-TRD")

    def test_hosts_patched_in_batches_and_stop_on_failure(self):
        plays = [p for p in load_plays() if p.get("hosts") != "localhost"]
        self.assertTrue(plays, "no host play")
        for p in plays:
            if any(module(e["task"]) == "apt" and e["play"] == load_plays().index(p) for e in entries()):
                self.assertIn("serial", p, "the play that upgrades must patch hosts in batches (serial)")
                self.assertTrue(p.get("any_errors_fatal") is True, "a failed host must stop the run (any_errors_fatal: true)")


class Guards(unittest.TestCase):
    """Evaluate every assert/fail that runs BEFORE the first state change for a matrix of (env, evidence, emergency)."""

    def test_clock_fact_set_before_the_guards(self):
        facts = [e for e in entries() if e["i"] < first_change_index() and module(e["task"]) == "set_fact"
                 and "patch_now_epoch" in json.dumps(e["task"])]
        self.assertTrue(facts, "set_fact patch_now_epoch (controller clock) must precede the guards")

    @staticmethod
    def skipped(e, ctx):
        for c in e["when"]:
            try:
                if not ev(c, ctx):
                    return True
            except Exception:
                pass
        return False

    def verdict(self, **ctx):
        ctx.setdefault("env", "prod")
        ctx.setdefault("topology_profile", "lean")
        ctx.setdefault("patch_now_epoch", NOW)
        pre = [e for e in entries() if e["i"] < first_change_index()]
        guards = [e for e in pre if module(e["task"]) in ("assert", "fail")]
        self.assertTrue(guards, "no guard (assert/fail) before the first state change")
        for e in guards:
            if module(e["task"]) == "assert":
                if self.skipped(e, ctx):
                    continue
                body = e["task"][next(k for k in e["task"] if k.endswith("assert"))] or {}
                for expr in as_list(body.get("that")):
                    try:
                        if not ev(expr, ctx):
                            return False
                    except Exception:
                        return False
            else:
                try:
                    if e["when"] and all(ev(c, ctx) for c in e["when"]):
                        return False
                except Exception:
                    pass
        return True

    def test_dev_needs_no_evidence(self):
        self.assertTrue(self.verdict(env="dev"))
        self.assertTrue(self.verdict(env="dev", patch_emergency=True))

    def test_staging_needs_evidence_from_dev(self):
        self.assertTrue(self.verdict(env="staging", patch_previous_done_at=NOW - 3600))
        self.assertTrue(self.verdict(env="staging", patch_previous_done_at=str(NOW - 3600)))
        self.assertFalse(self.verdict(env="staging"), "staging without dev evidence")
        self.assertFalse(self.verdict(env="staging", patch_previous_done_at=NOW + 600), "evidence from the future")
        for bad in (0, -5, "abc", "", "1e9", None):
            self.assertFalse(self.verdict(env="staging", patch_previous_done_at=bad), repr(bad))

    def test_prod_waits_the_24h_soak(self):
        self.assertTrue(self.verdict(patch_previous_done_at=NOW - DAY))
        self.assertTrue(self.verdict(patch_previous_done_at=str(NOW - 3 * DAY)))
        self.assertFalse(self.verdict(patch_previous_done_at=NOW - DAY + 1), "1 s short of the soak")
        self.assertFalse(self.verdict(patch_previous_done_at=NOW - 3600))
        self.assertFalse(self.verdict(patch_emergency=False, patch_previous_done_at=NOW - 60))

    def test_prod_without_or_with_bad_evidence_is_refused(self):
        self.assertFalse(self.verdict(), "prod with no staging evidence")
        for bad in (0, -5, "abc", "", "1e9", None, NOW + 60, "$(id)"):
            self.assertFalse(self.verdict(patch_previous_done_at=bad), repr(bad))
            self.assertFalse(self.verdict(patch_emergency=True, patch_previous_done_at=bad), "emergency " + repr(bad))

    def test_emergency_skips_the_soak_but_keeps_the_staging_evidence(self):
        self.assertTrue(self.verdict(patch_emergency=True, patch_previous_done_at=NOW - 60))
        self.assertTrue(self.verdict(patch_emergency="true", patch_previous_done_at=str(NOW - 60)))
        self.assertFalse(self.verdict(patch_emergency=True), "emergency without staging smoke evidence")
        self.assertFalse(self.verdict(patch_emergency=True, patch_previous_done_at=NOW + 60))

    def test_unknown_or_missing_env_refused(self):
        for e in ("qa", "PROD", "production", "", None, "dev; id"):
            self.assertFalse(self.verdict(env=e, patch_previous_done_at=NOW - 2 * DAY), repr(e))

    def test_both_profiles_behave_the_same(self):
        for prof in ("lean", "full"):
            self.assertTrue(self.verdict(topology_profile=prof, patch_previous_done_at=NOW - DAY), prof)
            self.assertFalse(self.verdict(topology_profile=prof, patch_previous_done_at=NOW - 60), prof)


class Flow(unittest.TestCase):
    def test_guards_before_any_change(self):
        es = entries()
        i = first_change_index()
        self.assertTrue(any(module(e["task"]) in ("assert", "fail") for e in es[:i]), "guards must come first")
        self.assertIn(module(es[i]["task"]), CHANGING + ("include_role", "import_role", "include_tasks"), "unexpected first change")

    def test_os_upgrade_by_apt_module_with_cache_refresh(self):
        up = upgrade_tasks()
        self.assertTrue(up, "no ansible.builtin.apt task with `upgrade:`")
        for e in up:
            a = args_of(e["task"])
            self.assertIn(str(a["upgrade"]).lower(), ("dist", "full", "safe", "yes", "true"))
            self.assertTrue(a.get("update_cache") or find(r"update_cache", [x for x in entries() if module(x["task"]) == "apt"]),
                            "apt cache must be refreshed")
        self.assertFalse(find(r"apt-get\s+(-y\s+)?(dist-)?upgrade|apt\s+(-y\s+)?upgrade"), "use the apt module, not a shell string")

    def test_no_force_no_floating_tags_no_ignored_errors_on_the_critical_steps(self):
        text = read(PLAYBOOK)
        self.assertNotRegex(text, r"--force-yes|:latest\b")
        for e in entries():
            if module(e["task"]) in ("apt", "reboot") or "last_patch_timestamp" in e["text"]:
                self.assertFalse(e["task"].get("ignore_errors"), "ignore_errors on %s" % e["task"].get("name"))

    def test_reboot_only_when_the_host_asks_for_it(self):
        es = entries()
        reb = [e for e in es if module(e["task"]) == "reboot"]
        self.assertTrue(reb, "kernel updates need a reboot (02-TRD s13): no ansible.builtin.reboot task")
        stats = [e for e in es if module(e["task"]) == "stat" and re.search(r"reboot-required", e["text"])]
        self.assertTrue(stats, "stat /var/run/reboot-required before rebooting")
        for r in reb:
            self.assertTrue(any(re.search(r"reboot", c) for c in r["when"]) or stats[0]["task"].get("register") and
                            any(stats[0]["task"]["register"] in c for c in r["when"]), "reboot must be conditional")
            self.assertGreater(r["i"], stats[0]["i"])
            self.assertGreater(r["i"], upgrade_tasks()[0]["i"], "reboot comes after the upgrade")

    def test_stamp_written_last_and_never_in_a_dry_run(self):
        es = entries()
        stamps = [e for e in es if "last_patch_timestamp" in e["text"] and module(e["task"]) in ("copy", "lineinfile", "template", "command", "shell")]
        self.assertTrue(stamps, "no task writes /var/lib/lims/patch/last_patch_timestamp")
        for s in stamps:
            self.assertIn("/var/lib/lims/patch", s["text"])
            self.assertNotEqual(s["task"].get("check_mode"), False, "a dry run must not refresh the patch metric")
            self.assertFalse(s["task"].get("ignore_errors"))
            self.assertNotEqual(s["section"], "rescue", "a failed run must not stamp")
            self.assertGreater(s["i"], upgrade_tasks()[0]["i"], "stamp after the upgrade")
            for r in [e for e in es if module(e["task"]) == "reboot"]:
                self.assertGreater(s["i"], r["i"], "stamp after the reboot")
            self.assertRegex(s["text"], r"epoch|patch_now_epoch|date \+%s|date_time", "stamp holds epoch seconds")

    def test_emergency_still_patches_and_stamps(self):
        for e in upgrade_tasks() + find(r"last_patch_timestamp"):
            for c in e["when"]:
                self.assertNotRegex(str(c), r"patch_emergency", "patch_emergency may only relax the soak guard, never skip the patch")

    def test_default_off(self):
        text = read(PLAYBOOK)
        self.assertRegex(text, r"patch_emergency\s*\|\s*default\(\s*(false|False)|patch_emergency:\s*(false|False)",
                         "patch_emergency must default to false")

    def test_no_secret_or_proxy_credentials_inline(self):
        self.assertNotRegex(read(PLAYBOOK), r"(?i)(password|token|secret)\s*[:=]\s*['\"]?[A-Za-z0-9+/]{12,}")


class _Script(unittest.TestCase):
    @staticmethod
    def bash():
        for c in (r"C:\Program Files\Git\bin\bash.exe", "/usr/bin/bash"):
            if os.path.exists(c):
                return c
        return shutil.which("bash")

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t28_"))
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.out = self.tmp / "textfile"
        self.out.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def stamp(self, content):
        (self.state / "last_patch_timestamp").write_bytes(content if isinstance(content, bytes) else content.encode())

    def run_script(self, textfile=True):
        self.assertTrue(SCRIPT.is_file(), "missing infra/monitoring/textfile/patch_metrics.sh")
        env = dict(os.environ, STATE_DIR=self.state.as_posix())
        env.pop("TEXTFILE_DIR", None)
        if textfile:
            env["TEXTFILE_DIR"] = self.out.as_posix()
        r = subprocess.run([self.bash(), SCRIPT.as_posix()], env=env, capture_output=True, text=True, timeout=60,
                           stdin=subprocess.DEVNULL, cwd=self.tmp)
        prom = self.out / "patch.prom"
        text = prom.read_text(encoding="utf-8") if prom.exists() else (r.stdout if not textfile else "")
        return r, text

    @staticmethod
    def samples(text):
        return [l for l in text.splitlines() if l.strip() and not l.startswith("#")]

    def positive(self, text):
        for l in self.samples(text):
            m = re.fullmatch(METRIC + r"(\{[^}]*\})?\s+(\S+)", l.strip())
            if m and float(m.group(2)) > 0:
                return True
        return False


class ScriptShape(unittest.TestCase):
    def test_shape(self):
        raw = SCRIPT.read_bytes() if SCRIPT.is_file() else b""
        self.assertTrue(raw, "missing %s" % SCRIPT.relative_to(ROOT).as_posix())
        self.assertTrue(raw.startswith(b"#!/usr/bin/env bash") or raw.startswith(b"#!/bin/bash"))
        self.assertNotIn(b"\r\n", raw, "CRLF breaks bash")
        text = raw.decode()
        self.assertRegex(text, r"(?m)^\s*set\s+-[a-z]*u")
        self.assertIn("/var/lib/lims/patch", text, "default STATE_DIR")
        self.assertIn("last_patch_timestamp", text)
        self.assertNotRegex(text, r"\b(apt|apt-get|dpkg|curl|wget|docker)\b\s+(install|upgrade|update|pull|run|exec)", "metric script is read-only")
        self.assertNotRegex(text, r"\beval\b", "the stamp text is data, never evaluated")
        r = subprocess.run([_Script.bash(), "-n", SCRIPT.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class PatchMetric(_Script):
    def test_fresh_stamp_exported_once_without_labels(self):
        ts = int(time.time()) - 3600
        self.stamp("%d\n" % ts)
        r, text = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.samples(text), ["%s %d" % (METRIC, ts)])

    def test_old_stamp_is_reported_faithfully_so_patch_overdue_can_fire(self):
        ts = int(time.time()) - 40 * DAY
        self.stamp(str(ts))
        r, text = self.run_script()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.samples(text), ["%s %d" % (METRIC, ts)])

    def test_stdout_when_no_textfile_dir(self):
        ts = int(time.time()) - 60
        self.stamp("%d" % ts)
        r, text = self.run_script(textfile=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.samples(r.stdout), ["%s %d" % (METRIC, ts)])

    def test_atomic_single_file_no_temp_left(self):
        self.stamp("%d" % (int(time.time()) - 60))
        self.run_script()
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["patch.prom"])

    def test_missing_stamp_fails_closed(self):
        r, text = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.positive(text), "never patched / unreadable must not look patched")

    def test_garbage_stamp_fails_closed_and_is_never_evaluated(self):
        marker = self.tmp / "pwned"
        for bad in ("", "abc", "12 34", "1e9", "-5", "0", "0x10", "1.5", "$(touch %s)" % marker.as_posix(),
                    "`touch %s`" % marker.as_posix(), "1800000000; touch %s" % marker.as_posix(), "99999999999999999999999"):
            self.stamp(bad)
            r, text = self.run_script()
            self.assertNotEqual(r.returncode, 0, repr(bad))
            self.assertFalse(self.positive(text), repr(bad))
        self.assertFalse(marker.exists(), "stamp content was executed")

    def test_future_stamp_rejected(self):  # a skewed clock or a forged stamp must not hide an overdue host
        self.stamp("%d" % (int(time.time()) + DAY))
        r, text = self.run_script()
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.positive(text))

    def test_stale_prom_never_survives_a_failed_read(self):
        (self.out / "patch.prom").write_text("%s %d\n" % (METRIC, int(time.time()) - 60), encoding="utf-8")
        r, text = self.run_script()  # no stamp
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.positive(text), "a stale fresh-looking sample survived")

    def test_multi_line_stamp_cannot_forge_extra_samples(self):
        ts = int(time.time()) - 60
        self.stamp("%d\n%s{host=\"x\"} %d\n" % (ts, METRIC, ts))
        r, text = self.run_script()
        self.assertEqual(len(self.samples(text)), 1 if r.returncode == 0 else 0, text)
        self.assertNotIn('host="x"', text)


class Scheduling(unittest.TestCase):
    @staticmethod
    def files():
        return [p for p in ANSIBLE.rglob("*") if p.is_file() and p.suffix in (".yml", ".yaml", ".j2", ".timer", ".service", ".sh")]

    def test_script_installed_by_ansible(self):
        refs = [p for p in self.files() if "patch_metrics.sh" in p.read_text(encoding="utf-8", errors="replace")]
        self.assertTrue(refs, "no Ansible file installs/references textfile/patch_metrics.sh")

    def test_timer_and_service_feed_the_node_exporter_textfile_dir_as_root(self):
        fs = self.files()
        timers = [p for p in fs if re.search(r"patch[-_]metrics", p.name) and ".timer" in p.name]
        self.assertTrue(timers, "no patch-metrics .timer (or .timer.j2) under infra/ansible")
        self.assertRegex("\n".join(p.read_text(encoding="utf-8") for p in timers),
                         r"(?m)^\s*(OnUnitActiveSec|OnUnitInactiveSec|OnCalendar)\s*=")
        services = [p for p in fs if re.search(r"patch[-_]metrics", p.name) and ".service" in p.name]
        self.assertTrue(services, "no patch-metrics .service (or .service.j2)")
        s = "\n".join(p.read_text(encoding="utf-8") for p in services)
        self.assertIn("patch_metrics.sh", s)
        self.assertIn("/var/lib/node_exporter/textfile", s)
        self.assertNotRegex(s, r"(?m)^\s*User\s*=\s*(?!root\b)\S+")

    def test_patch_playbook_creates_the_state_dir_the_script_reads(self):
        self.assertIn("/var/lib/lims/patch", read(PLAYBOOK))


class PatchOverdueRule(unittest.TestCase):
    """T-28 `tests`: PatchOverdue promtool test (AC-16.1). The rule is T-19's; pinned so it cannot drift."""

    def rule(self):
        groups = yaml.safe_load(read(RULES))["groups"]
        rs = [r for g in groups for r in g["rules"] if r.get("alert") == "PatchOverdue"]
        self.assertEqual(len(rs), 1, "PatchOverdue must exist exactly once")
        return rs[0]

    def test_rule_is_35_days_warn_per_host(self):
        r = self.rule()
        self.assertEqual(re.sub(r"\s+", "", r["expr"]), "time()-%s>35*86400" % METRIC)
        self.assertEqual(r["labels"]["severity"], "warn")
        self.assertNotIn("for", r)

    def test_promtool_cases_cover_quiet_and_firing(self):
        tests = yaml.safe_load(read(RULE_TESTS))["tests"]
        pt = [t for t in tests if "PatchOverdue" in t.get("name", "")]
        self.assertGreaterEqual(len(pt), 2)
        fires = [a for t in pt for a in t["alert_rule_test"] if a["alertname"] == "PatchOverdue" and a["exp_alerts"]]
        quiet = [a for t in pt for a in t["alert_rule_test"] if a["alertname"] == "PatchOverdue" and not a["exp_alerts"]]
        self.assertTrue(fires and quiet)

    def test_promtool_passes_when_installed(self):  # not installed on the tester box: the CI job runs it (02-TRD s12.2)
        if not shutil.which("promtool"):
            return
        r = subprocess.run(["promtool", "test", "rules", RULE_TESTS.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class RunbookContent(unittest.TestCase):
    @staticmethod
    def slug(h):
        s = re.sub(r"[^\w\s-]", "", h.strip().lower())
        return re.sub(r"\s", "-", s)

    def text(self):
        return read(RUNBOOK)

    def sections(self):
        out, cur = {}, None
        for l in self.text().splitlines():
            m = re.match(r"^##\s+(.+?)\s*$", l)
            if m:
                cur = self.slug(m.group(1))
                out[cur] = []
            elif cur:
                out[cur].append(l)
        return {k: "\n".join(v) for k, v in out.items()}

    def test_required_sections(self):
        s = self.sections()
        for h in ("monthly-window", "emergency-patch", "kernel-reboots", "patch-log", "dry-run"):
            self.assertIn(h, s, "missing section ## %s" % h)

    def test_monthly_window_and_order(self):
        s = self.sections()["monthly-window"]
        self.assertRegex(s, r"(?i)second saturday")
        self.assertRegex(s, r"22:00.{1,4}02:00")
        self.assertIn("NPT", s)
        self.assertRegex(s, r"(?is)dev.{0,80}staging.{0,120}prod")
        self.assertRegex(s, r"(?i)24\s*h")
        self.assertIn("patch_previous_done_at", s)
        self.assertIn("patch.yml", s)
        self.assertRegex(s, r"(?i)35\s*days|PatchOverdue")
        self.assertIn(METRIC, self.text())

    def test_emergency_path(self):
        s = self.sections()["emergency-patch"]
        self.assertIn("patch_emergency", s)
        self.assertRegex(s, r"72\s*h")
        self.assertIn("9.0", s)
        self.assertRegex(s, r"(?i)actively exploited")
        self.assertRegex(s, r"(?i)on-call")
        self.assertRegex(s, r"(?i)skips?.{0,40}soak")
        self.assertRegex(s, r"(?i)staging smoke|smoke test")
        self.assertRegex(s, r"(?i)patch log")

    def test_kernel_reboots(self):
        s = self.sections()["kernel-reboots"]
        self.assertRegex(s, r"(?i)reboot")
        self.assertRegex(s, r"(?i)standby")
        self.assertRegex(s, r"(?i)status page")
        self.assertRegex(s, r"48\s*h")

    def test_dry_run_section(self):
        s = self.sections()["dry-run"]
        self.assertIn("--check", s)
        self.assertRegex(s, r"ansible-playbook\s+playbooks/patch\.yml|patch\.yml")
        self.assertRegex(s, r"(?i)does not (update|refresh|write).{0,60}(metric|stamp)|no stamp|not stamp")

    def test_patch_log_is_a_table_with_ac_16_2_columns(self):
        s = self.sections()["patch-log"]
        rows = [l for l in s.splitlines() if l.strip().startswith("|")]
        self.assertGreaterEqual(len(rows), 2, "patch log must be a Markdown table (header + separator)")
        head = rows[0].lower()
        for col in ("date", "env", "type", "cve", "triage", "prod"):
            self.assertIn(col, head, "patch log header lacks %r" % col)
        self.assertRegex(rows[1], r"^\|?\s*:?-{3,}")
        self.assertRegex(s, r"(?i)pull request|PR")
        self.assertRegex(s, r"72\s*h")

    def test_no_secret_values_no_real_names(self):
        t = self.text()
        self.assertNotRegex(t, r"(?i)(password|token|secret|api[_-]?key)\s*[:=]\s*\S{8,}")
        self.assertNotRegex(t, r"(?i)BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY")

    def test_runbook_index_lists_it(self):
        self.assertRegex(read(ROOT / "infra" / "runbooks" / "README.md"), r"\]\(patching\.md[)#]")


if __name__ == "__main__":
    unittest.main()
