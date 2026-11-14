"""T-29 tests (tester role): DR promotion playbook + runbook, incl. degraded mode (08 A25 D-210).

Covers 06-PLAN row T-29 (done_when: staging game day - promote standby, app reconnects, RTO measured, interim repo
`check` passes, `NoOffsiteArchive` fires and stays firing; site-failover tabletop; tests: game-day record), AC-22.1,
AC-22.2, AC-22.3, 02-TRD s3.2 (db_net rule), s5.5, s9, s11.3 (`NoOffsiteArchive`), s15 (`db_primary_wg_ip`),
03-APP-FLOW s11.1/s11.2, 04-UI-UX s7 (`dr-promote.yml -e confirm_env=prod`), 07-SECURITY REQ-SEC-126/127.
LD-45: the playbook uses group names only; `lean` has NO hot standby (group `dr` empty) so it refuses there and the
runbook sends the reader to the restore-onto-a-fresh-VM procedure; `full` is the profile the game day exercises.

NOT provable here (no ansible, docker, PostgreSQL, pgBackRest, second site): a real promotion, the measured RTO, the
real interim-repo `check`, `NoOffsiteArchive` firing in Prometheus, the staging game day itself, the site-failover
tabletop (humans; their records are checked by shape once they exist, see GameDayRecord). These tests prove the
committed artefacts: structure, guards (Jinja2-evaluated), ordering, secret hygiene, runbook content.

CONTRACTS where the spec is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ansible/playbooks/dr-promote.yml: YAML list of plays; each play `hosts` in {localhost, dr, app, ops}; every
   non-localhost play `become: true`; no literal host names; header cites LD-45 and D-210.
 * Guards BEFORE the promote task (ansible.builtin.assert / fail, evaluated with plain Jinja2): `confirm_env` must
   equal `env` (04 s7: `-e confirm_env=prod`; missing or other value refuses); `topology_profile == 'full'` (lean refuses,
   message names `dr.md#lean-restore-onto-a-fresh-vm`); groups `dr` and `ops` non-empty; a split-brain probe: the old primary
   (`groups['data'][0]` wg_ip, port 5432) must NOT answer (a failing/inverted reachability check stops the play).
 * Flow order: ops_audit start note (via ci/ops-note.sh, argv form) and `dr_promote_started_epoch` fact -> promote
   (`pg_promote(` or `pg_ctl promote` inside the standby container `standby_container`) -> wait until recovery is
   over (`until`, retries) -> NoOffsiteArchive metric -> `db_primary_wg_ip` := the first `dr` host's wg_ip, db_net
   DOCKER-USER rule re-rendered with it (role nftables or the template) and consumers api-a api-b worker-a worker-b
   auth rest storage recreated with `--force-recreate --wait` and DATA_WG_IP = the new value -> smoke on
   `/v1/core/health/ready` with retries -> incident record (ops_audit note) -> interim repo -> ops_audit end note with
   `rto_seconds=`.
 * NoOffsiteArchive stays firing: right after the promotion, BEFORE the interim repo, the playbook writes a node-exporter
   textfile (/var/lib/node_exporter/textfile/*.prom, atomic: temp file + rename or `ansible.builtin.copy` which is
   atomic) holding `lims_ops_offsite_archive_configured 0`; NOTHING in the playbook ever writes `... 1` (the interim repo
   is on the same site as the promoted primary, so it never counts as offsite; only a repo at another site does, and
   that is outside this playbook). The existing rule (backup.rules.yml, expr `== 0`, for 5m, page) is unchanged.
 * Incident record: one ops_audit note containing `degraded`, `no second-site archive` and `audit store` (03 s11.1).
 * Interim repo (AC-22.3): tasks tagged `interim_repo` (so `--tags interim_repo` repeats it inside the 4 h window);
   pgbackrest `stanza-create` then `check` on the promoted host; repo host = first host of group `ops` (never the
   promoted host, never the old primary); cipher `aes-256-cbc` with a freshly generated pass (its own pass, never the
   repo1/repo2 one); the pass is handled with no_log and is never written on a host of group `ops`; a failing
   stanza-create/check fails the play (no ignore_errors / failed_when false); the deadline `14400` s (4 h) is in the file.
 * Hygiene: every ops_audit note is `ansible.builtin.command` + `argv` (never a shell string); no `debug` prints a
   secret; no `--repo*-cipher-pass` / `PGPASSWORD=<literal>` on a command line; the play never deletes anything
   (no stanza-delete, rm -rf, drop database).
 * Failure: a `rescue:` writes an ops_audit note and ends with ansible.builtin.fail (a half promotion is never rc 0).
 * infra/runbooks/dr.md: level-2 headings (GitHub slugs) host-loss-data-1... see RUNBOOK_ANCHORS; content checks in
   RunbookContent. No secret values, no real names.
Stdlib + PyYAML + Jinja2. Missing file = FAIL (never skip). Run from repo root:
  python -B -m unittest discover -s infra/tests/static -p "test_t29_*.py" -v
"""
import json
import re
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOK = ROOT / "infra" / "ansible" / "playbooks" / "dr-promote.yml"
RUNBOOK = ROOT / "infra" / "runbooks" / "dr.md"
RULES = ROOT / "infra" / "monitoring" / "rules" / "backup.rules.yml"
TABLETOPS = ROOT / "infra" / "runbooks" / "tabletop-log"
GAMEDAYS = ROOT / "infra" / "runbooks" / "gameday-log"

HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|dev-1)\b")
KEYWORDS = {
    "name", "when", "register", "no_log", "become", "become_user", "vars", "loop", "with_items", "loop_control",
    "delegate_to", "changed_when", "failed_when", "tags", "notify", "args", "environment", "ignore_errors", "retries",
    "delay", "until", "check_mode", "run_once", "any_errors_fatal", "throttle", "timeout", "diff", "listen",
    "async", "poll",
}
# LD-45: group/host data comes from the active profile; the playbook only ever sees `full` as runnable.
PROFILES = {
    "full": {"hosts": {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"},
             "groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]}},
    "lean": {"hosts": {"prod-1": "10.79.0.11", "backup-1": "10.79.0.15"},
             "groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": []}},
}
CONSUMERS = ["api-a", "api-b", "worker-a", "worker-b", "auth", "rest", "storage"]
RUNBOOK_ANCHORS = [
    "host-loss-data-1", "promote-standby", "app-reconnect", "degraded-mode", "interim-repo", "nooffsitearchive",
    "site-a-loss", "dr-site-failover", "lean-restore-onto-a-fresh-vm", "switch-back", "game-day",
]


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


def walk(tasks, section="main", when=(), nolog=False, tags=(), host=""):
    for t in tasks or []:
        if not isinstance(t, dict):
            continue
        tg = tags + tuple(as_list(t.get("tags")))
        if any(k in t for k in ("block", "rescue", "always")):
            w = when + tuple(as_list(t.get("when")))
            nl = nolog or bool(t.get("no_log"))
            for key in ("block", "rescue", "always"):
                sec = "rescue" if key == "rescue" else section
                yield from walk(t.get(key), sec, w, nl, tg, host)
        else:
            yield {"task": t, "section": section, "when": when + tuple(as_list(t.get("when"))),
                   "no_log": nolog or bool(t.get("no_log")), "tags": tg, "host": host,
                   "text": json.dumps(t, default=str)}


def entries():
    out = []
    for p in load_plays():
        ptags = tuple(as_list(p.get("tags")))
        for key in ("pre_tasks", "tasks", "post_tasks"):
            out += list(walk(p.get(key), tags=ptags, nolog=bool(p.get("no_log")), host=str(p.get("hosts"))))
    for i, e in enumerate(out):
        e["i"] = i
    return out


def module(task):
    for k in task:
        if k not in KEYWORDS:
            return k.split(".")[-1]
    return ""


_J = jinja2.Environment(undefined=jinja2.Undefined)
for _n in ("match", "search", "regex"):
    _J.tests[_n] = (lambda f: (lambda v, p: f(p, str(v)) is not None))(re.match if _n == "match" else re.search)
_J.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")


def ev(expr, ctx):
    return _J.compile_expression(str(expr))(**ctx)


def ctx(profile="full", **extra):
    p = PROFILES[profile]
    c = {"env": "staging", "topology_profile": profile, "groups": p["groups"],
         "hostvars": {h: {"wg_ip": ip} for h, ip in p["hosts"].items()}, "confirm_env": "staging",
         "standby_container": "standby-db"}
    c.update(extra)
    return c


def find(pattern, es=None, flags=re.I):
    return [e for e in (es if es is not None else entries()) if re.search(pattern, e["text"], flags)]


def first(pattern, es=None):
    f = find(pattern, es)
    if not f:
        raise AssertionError("no task matches /%s/" % pattern)
    return f[0]["i"]


PROMOTE_RE = r"pg_promote\(|pg_ctl.{0,40}promote"


def promote_index():
    return first(PROMOTE_RE)


def notes():
    return [e for e in entries() if re.search(r"ops-note", e["text"])]


class PlaybookShape(unittest.TestCase):
    def test_plays_use_group_names_with_become(self):
        for p in load_plays():
            self.assertIn(p.get("hosts"), ("localhost", "dr", "app", "ops"), "play hosts: group names only (LD-45)")
            if p.get("hosts") != "localhost":
                self.assertTrue(p.get("become"), "become: true required on host plays")

    def test_no_host_names_and_cites_ld45_and_d210(self):
        text = read(PLAYBOOK)
        self.assertIsNone(HOSTNAMES.search(text), "literal host name in playbook")
        self.assertIn("LD-45", text)
        self.assertRegex(text, r"D-210")

    def test_covers_dr_app_and_ops_groups(self):
        hosts = {p.get("hosts") for p in load_plays()}
        self.assertTrue({"dr", "app", "ops"} <= hosts, "plays needed for dr (promote), app (reconnect), ops (interim repo)")

    def test_every_task_is_named(self):
        for e in entries():
            self.assertTrue(e["task"].get("name"), "unnamed task: %s" % e["text"][:80])


class Guards(unittest.TestCase):
    """Everything before the promote task must be able to refuse; evaluated with the active profile fixture."""

    def guards(self):
        pre = [e for e in entries() if e["i"] < promote_index()]
        g = [e for e in pre if module(e["task"]) in ("assert", "fail")]
        self.assertTrue(g, "no assert/fail before the promote task")
        return g

    def verdict(self, **c):
        for e in self.guards():
            if module(e["task"]) == "assert":
                body = e["task"][next(k for k in e["task"] if k.endswith("assert"))] or {}
                try:
                    if e["when"] and not all(ev(w, c) for w in e["when"]):
                        continue
                    if not all(ev(x, c) for x in as_list(body.get("that"))):
                        return False
                except Exception:
                    return False
            else:
                try:
                    if e["when"] and all(ev(w, c) for w in e["when"]):
                        return False
                except Exception:
                    pass
        return True

    def test_valid_full_profile_run_passes(self):
        self.assertTrue(self.verdict(**ctx("full", env="staging", confirm_env="staging")))
        self.assertTrue(self.verdict(**ctx("full", env="prod", confirm_env="prod")))

    def test_confirm_env_missing_or_wrong_refuses(self):  # DESTRUCTIVE (04 s7)
        c = ctx("full", env="prod")
        c.pop("confirm_env")
        self.assertFalse(self.verdict(**c), "no confirm_env must refuse")
        self.assertFalse(self.verdict(**ctx("full", env="prod", confirm_env="staging")))
        self.assertFalse(self.verdict(**ctx("full", env="prod", confirm_env="")))

    def test_lean_refuses_and_points_to_restore_procedure(self):  # LD-45: no hot standby in lean
        self.assertFalse(self.verdict(**ctx("lean", env="prod", confirm_env="prod")))
        self.assertIn("dr.md#lean-restore-onto-a-fresh-vm", read(PLAYBOOK))

    def test_missing_profile_refuses(self):
        c = ctx("full")
        c.pop("topology_profile")
        self.assertFalse(self.verdict(**c), "fail closed without topology_profile")

    def test_empty_dr_or_ops_group_refuses(self):
        for grp in ("dr", "ops"):
            c = ctx("full")
            c["groups"] = {**c["groups"], grp: []}
            self.assertFalse(self.verdict(**c), "empty group %s must refuse" % grp)

    def test_split_brain_probe_on_old_primary(self):  # promoting while the primary lives = two primaries
        pre = [e for e in entries() if e["i"] < promote_index()]
        hit = find(r"groups\[.data.\]", pre)
        hit = [e for e in hit if "5432" in e["text"]]
        self.assertTrue(hit, "a check of the old primary (groups['data'][0] wg_ip, port 5432) must run before promoting")
        t = hit[0]["text"]
        self.assertRegex(t, r"stopped|failed_when|rc\s*[!=]|unreachable|is not|== *0",
                         "the probe must STOP the play when the old primary still answers")


class Flow(unittest.TestCase):
    def test_start_note_and_started_epoch_before_promote(self):
        p = promote_index()
        self.assertLess(first(r"ops-note.*start|dr-promote start|promotion (requested|started)"), p)
        self.assertLess(first(r"dr_promote_started_epoch"), p)

    def test_promote_runs_inside_the_standby_container_and_waits(self):
        e = entries()[promote_index()]
        self.assertRegex(e["text"], r"standby_container|standby-db", "promote must exec in the standby container")
        self.assertRegex(e["text"], r"docker.{0,10}exec", "promote via docker exec")
        w = [x for x in entries() if x["i"] > e["i"] and "pg_is_in_recovery" in x["text"]]
        self.assertTrue(w, "wait until pg_is_in_recovery() is false")
        t = w[0]["task"]
        self.assertTrue("until" in t and "retries" in t, "recovery wait needs until + retries")

    def test_never_promotes_when_check_mode(self):
        e = entries()[promote_index()]
        self.assertNotIn('"check_mode": false', e["text"].lower(), "never force check_mode: false on the promote")

    def test_ordering_of_the_whole_flow(self):
        order = [
            ("promote", promote_index()),
            ("metric", first(r"lims_ops_offsite_archive_configured")),
            ("db_primary switch", first(r"db_primary_wg_ip")),
            ("consumers", first(r"force-recreate")),
            ("smoke", first(r"health/ready")),
            ("incident record", first(r"no second-site archive")),
            ("stanza-create", first(r"stanza-create")),
            ("check", max(e["i"] for e in find(r"pgbackrest.{0,200}\bcheck\b|\bcheck\b.{0,200}pgbackrest"))),
            ("rto end note", first(r"rto_seconds")),
        ]
        idx = [i for _, i in order]
        self.assertEqual(idx, sorted(idx), "wrong order: %s" % order)

    def test_db_primary_wg_ip_becomes_the_dr_host_ip(self):
        sets = [e for e in entries() if module(e["task"]) == "set_fact" and "db_primary_wg_ip" in e["text"]]
        self.assertTrue(sets, "set_fact db_primary_wg_ip")
        facts = next(v for k, v in sets[0]["task"].items() if k.endswith("set_fact"))
        for prof in ("full",):
            c = ctx(prof)
            val = _J.from_string(str(facts["db_primary_wg_ip"])).render(**c).strip()
            want = c["hostvars"][c["groups"]["dr"][0]]["wg_ip"]
            self.assertEqual(val, want, "db_primary_wg_ip must be the first dr host's wg_ip, not the old primary's")

    def test_docker_user_rule_is_re_rendered_with_the_new_ip(self):  # 02-TRD s3.2 / s5.5 db_net rule
        t = read(PLAYBOOK)
        self.assertRegex(t, r"nftables", "db_net DOCKER-USER rule (nftables role/template) must be re-applied")
        e = find(r"nftables")
        self.assertTrue(any("db_primary_wg_ip" in x["text"] for x in e)
                        or any(x["i"] > first(r"set_fact.*db_primary_wg_ip|db_primary_wg_ip") for x in e))

    def test_every_consumer_recreated_with_new_ip(self):
        recreate = find(r"force-recreate")
        self.assertTrue(recreate)
        text = " ".join(e["text"] for e in recreate)
        for c in CONSUMERS:
            self.assertRegex(text, r"(?<![\w-])%s(?![\w-])" % re.escape(c), "consumer %s not recreated" % c)
        for e in recreate:
            self.assertIn("--wait", e["text"], "recreate must be health-gated (--wait)")
            self.assertIn("DATA_WG_IP", e["text"] + json.dumps(e["task"].get("environment", {})),
                          "recreate must pass DATA_WG_IP = the new primary")
        self.assertNotRegex(text, r"docker compose[^\"]*\brestart\b", "restart does not re-read env; recreate")

    def test_smoke_retries_after_reconnect(self):  # AC-22.1: app reconnects
        e = [x for x in entries() if "health/ready" in x["text"]]
        self.assertTrue(e)
        self.assertTrue("until" in e[0]["task"] and "retries" in e[0]["task"], "smoke needs until + retries")


class DegradedMode(unittest.TestCase):  # D-210, AC-22.3
    def test_metric_zero_written_before_the_interim_repo_and_never_one(self):
        w = [e for e in entries() if re.search(r"lims_ops_offsite_archive_configured\s+0", e["text"])]
        self.assertTrue(w, "write `lims_ops_offsite_archive_configured 0`")
        self.assertLess(w[0]["i"], first(r"stanza-create"), "metric must be 0 from promotion, before the interim repo")
        self.assertGreater(w[0]["i"], promote_index())
        self.assertIn("/var/lib/node_exporter/textfile/", w[0]["text"])
        self.assertIn(".prom", w[0]["text"])
        self.assertNotRegex(read(PLAYBOOK), r"lims_ops_offsite_archive_configured\s+1\b",
                            "the interim repo (same site) must NEVER set offsite=1")

    def test_metric_write_is_atomic(self):
        e = [e for e in entries() if re.search(r"lims_ops_offsite_archive_configured\s+0", e["text"])][0]
        m = module(e["task"])
        self.assertTrue(m in ("copy", "template") or re.search(r"mv |rename|atomic", e["text"]),
                        "textfile must be replaced atomically (copy/template or tmp+mv)")

    def test_alert_rule_still_stays_firing(self):  # unchanged contract of 02-TRD s11.3
        rules = yaml.safe_load(read(RULES))
        rule = next(r for g in rules["groups"] for r in g["rules"] if r.get("alert") == "NoOffsiteArchive")
        self.assertEqual(rule["expr"].replace(" ", ""), "lims_ops_offsite_archive_configured==0")
        self.assertEqual(rule["for"], "5m")
        self.assertEqual(rule["labels"]["severity"], "page")

    def test_incident_record_names_the_degraded_period(self):  # 03 s11.1, AC-22.1
        hit = [e for e in notes() if all(re.search(p, e["text"], re.I) for p in
                                         (r"degraded", r"no second-site archive", r"audit store"))]
        self.assertTrue(hit, "ops_audit note must say: degraded, no second-site archive, audit store ...")
        self.assertLess(hit[0]["i"], first(r"stanza-create"))
        self.assertGreater(hit[0]["i"], promote_index())

    def test_interim_repo_tasks_tagged_and_ordered(self):
        tagged = [e for e in entries() if "interim_repo" in e["tags"]]
        self.assertTrue(tagged, "tag interim_repo (repeatable inside the 4 h window)")
        s = [e for e in tagged if "stanza-create" in e["text"]]
        c = [e for e in tagged if re.search(r"pgbackrest.{0,200}\bcheck\b", e["text"])]
        self.assertTrue(s and c, "tagged stanza-create and check")
        self.assertLess(s[0]["i"], c[-1]["i"])

    def test_interim_repo_host_is_the_ops_host_not_the_promoted_one(self):
        t = [e for e in entries() if "stanza-create" in e["text"]][0]["text"]
        self.assertRegex(t, r"groups\[.ops.\]", "repo host must come from group ops")
        self.assertNotRegex(t, r"groups\[.data.\]", "the old primary is not the repo host")
        c = ctx("full")
        self.assertNotEqual(c["groups"]["ops"][0], c["groups"]["dr"][0], "fixture: ops and dr differ in full")

    def test_interim_repo_is_encrypted_with_its_own_pass(self):
        t = read(PLAYBOOK)
        self.assertRegex(t, r"aes-256-cbc")
        for e in find(r"cipher"):
            self.assertTrue(e["no_log"], "task touching the cipher pass needs no_log: %s" % e["task"].get("name"))
        self.assertNotRegex(t, r"repo[123]_cipher_pass|pgbackrest_repo[12]_cipher", "must not reuse the repo1/repo2 pass")
        self.assertRegex(t, r"password_hash|lookup\('password'|openssl rand|ansible\.builtin\.password|random|urandom|secrets",
                         "a fresh CSPRNG pass is generated")

    def test_cipher_pass_never_written_on_the_ops_host(self):
        for e in entries():
            if e["host"] == "ops":
                self.assertNotRegex(e["text"], r"cipher", "ops host must not hold the interim repo's cipher pass")

    def test_stanza_create_and_check_must_fail_the_play(self):
        for e in find(r"stanza-create|pgbackrest.{0,200}\bcheck\b"):
            self.assertNotIn('"ignore_errors": true', e["text"].lower())
            self.assertNotRegex(e["text"], r'"failed_when": (false|"false")', "check result must not be swallowed")

    def test_four_hour_deadline_is_encoded(self):
        self.assertRegex(read(PLAYBOOK), r"14400", "AC-22.3: 4 h = 14400 s deadline")

    def test_rto_measured_and_recorded(self):
        end = [e for e in notes() if "rto_seconds" in e["text"]]
        self.assertTrue(end, "end note carries rto_seconds=")
        self.assertRegex(end[-1]["text"], r"dr_promote_started_epoch|ansible_date_time|now\(|lookup\('pipe'|epoch")


class Hygiene(unittest.TestCase):
    def test_ops_notes_are_argv_not_shell(self):
        ns = notes()
        self.assertGreaterEqual(len(ns), 3, "start, incident record, end (+ failure in rescue)")
        for e in ns:
            self.assertEqual(module(e["task"]), "command")
            body = e["task"].get("ansible.builtin.command") or e["task"].get("command")
            self.assertTrue(isinstance(body, dict) and "argv" in body, "ops-note via argv: %s" % e["task"].get("name"))

    def test_no_secret_on_command_lines_or_debug(self):
        text = read(PLAYBOOK)
        self.assertNotRegex(text, r"--repo\d?-cipher-pass|PGPASSWORD=[^\s{$]", "no secret on a command line")
        for e in entries():
            if module(e["task"]) == "debug":
                self.assertNotRegex(e["text"], r"cipher|password|secret", "debug must not print secrets")

    def test_nothing_is_deleted(self):
        self.assertNotRegex(read(PLAYBOOK), r"stanza-delete|rm -rf|drop database|state: absent|pgbackrest.{0,40}expire",
                            "a DR promotion deletes nothing")

    def test_rescue_notes_and_fails(self):
        r = [e for e in entries() if e["section"] == "rescue"]
        self.assertTrue(r, "rescue: required")
        self.assertTrue(any("ops-note" in e["text"] for e in r), "rescue writes an ops_audit note")
        self.assertEqual(module(r[-1]["task"]), "fail", "rescue must end with fail (never rc 0 after a half promotion)")


class RunbookContent(unittest.TestCase):
    def doc(self):
        return read(RUNBOOK)

    def heads(self):
        out = {}
        cur = None
        for line in self.doc().splitlines():
            m = re.match(r"##\s+(.*\S)\s*$", line)
            if m:
                cur = re.sub(r"[^a-z0-9 -]", "", m.group(1).lower()).replace(" ", "-")
                out[cur] = []
            elif cur:
                out[cur].append(line)
        return {k: "\n".join(v) for k, v in out.items()}

    def test_anchors_exist(self):
        h = self.heads()
        for a in RUNBOOK_ANCHORS:
            self.assertIn(a, h, "dr.md needs `## ` heading with slug %s" % a)

    def test_host_loss_section_matches_the_playbook(self):
        b = self.heads().get("host-loss-data-1", "")
        for p in (r"dr-promote\.yml", r"confirm_env", r"30 min", r"split.brain|fenc", r"db_primary_wg_ip"):
            self.assertRegex(b, p)

    def test_degraded_mode_text(self):
        b = self.heads().get("degraded-mode", "")
        for p in (r"NoOffsiteArchive", r"no second-site archive", r"audit store", r"incident record",
                  r"switch-back|switch back", r"loss of (site B|the site)|site B"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_interim_repo_text(self):
        b = self.heads().get("interim-repo", "")
        for p in (r"4 h", r"stanza-create", r"check", r"--tags interim_repo", r"same site"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_nooffsitearchive_names_when_it_ends(self):
        b = self.heads().get("nooffsitearchive", "")
        self.assertRegex(b, r"(?i)site other than|another site|different site")
        self.assertRegex(b, r"(?i)stays|keeps firing|until")

    def test_site_failover_has_rto_and_dns(self):
        b = self.heads().get("dr-site-failover", "")
        for p in (r"4 h", r"registry mirror", r"DNS", r"TTL 300", r"promote", r"15 min"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_lean_section_is_the_restore_procedure(self):  # LD-45
        b = self.heads().get("lean-restore-onto-a-fresh-vm", "")
        for p in (r"backup host|repo2", r"fresh VM", r"4 h", r"restore"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_game_day_script_records_the_measurements(self):
        b = self.heads().get("game-day", "")
        for p in (r"RTO", r"interim repo", r"NoOffsiteArchive", r"stays firing|still firing", r"gameday-log/",
                  r"semi-annual|every 6 months|twice a year", r"tabletop"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_game_day_staging_step1_stops_only_postgres_and_records_interim_host(self):
        # review round 2 item 1: staging data-1+app-1 share one VM, dr-1+ops-1 share one VM (02-TRD:154)
        b = self.heads().get("game-day", "")
        s1 = re.search(r"(?m)^1\.\s.*$", b)
        self.assertTrue(s1, "game day step 1 missing")
        s1 = s1.group(0)
        self.assertRegex(s1, r"(?i)staging[^.\n]*only[^.\n]*postgres container", "staging: stop only the Postgres container")
        self.assertRegex(s1, r"(?i)5432|split.brain probe", "step 1 names the closed port / split-brain probe")
        self.assertRegex(s1, r"(?i)prod[^.\n]*fence[^.\n]*data host", "prod: fence the data host")
        self.assertNotRegex(s1, r"(?i)stop the staging data host", "old text would also take the app hosts down")
        self.assertRegex(b, r"Interim repo host", "record key `Interim repo host` in step 4")
        self.assertRegex(b, r"(?i)staging[^.\n]*interim repo[^.\n]*(shares|same)[^.\n]*(VM|host)", "staging shares the promoted VM")
        self.assertRegex(b, r"groups\['ops'\]\[0\]\s*!=\s*groups\['dr'\]\[0\]", "AC-22.3 different-host proven only when ops != dr host")

    def test_switch_back_text(self):
        b = self.heads().get("switch-back", "")
        # repo2 is required only while the playbook archives to repo2 (review item 3; see Repo2ArchiveConflict)
        for p in (r"standby", r"repo2" if re.search(r"repo2-", read(PLAYBOOK)) else r"interim repo|fresh backup", r"window"):
            self.assertRegex(b, re.compile(p, re.I))

    def test_no_secret_values_or_real_hosts_in_runbook(self):
        d = self.doc()
        self.assertNotRegex(d, r"(?i)(password|cipher.?pass|token)\s*[:=]\s*[A-Za-z0-9+/]{12,}")
        self.assertNotRegex(d, r"\b(?:\d{1,3}\.){3}\d{1,3}\b(?<!\.0\.0\.0)", "no literal IPs in the runbook")


class InterimRepoAccess(unittest.TestCase):
    """Review item 1: the interim SFTP account must pass sshd `AllowGroups` and be chrooted (02-TRD s3.3 style).
    CONTRACT (tester): group `lims-interim-repo`; hardening template `AllowGroups ops lims-interim-repo`; trailing
    `Match User lims-interim-repo` (ChrootDirectory /srv/lims/interim-repo, ForceCommand internal-sftp,
    AllowTcpForwarding no); chroot dir root:root 0755 with a user-owned `repo` subdir; `repo1-path` is chroot-relative
    (/repo/...); sshd validated and reloaded."""

    HARDEN = ROOT / "infra" / "ansible" / "roles" / "hardening" / "templates" / "lims.conf.j2"
    CHROOT = "/srv/lims/interim-repo"

    def ops_tasks(self):
        return [e for e in entries() if e["host"] == "ops"]

    def sshd(self):
        return _J.from_string(read(self.HARDEN)).render(wg_ip="10.79.0.14")

    def test_group_exists_and_account_is_in_it(self):
        t = self.ops_tasks()
        g = [e for e in t if module(e["task"]) == "group" and "lims-interim-repo" in e["text"]]
        self.assertTrue(g, "ansible.builtin.group lims-interim-repo (dedicated group, not ops)")
        u = [e for e in t if module(e["task"]) == "user"]
        self.assertTrue(u and re.search(r'"(group|groups)": "lims-interim-repo"|lims-interim-repo"?\]', u[0]["text"]),
                        "the interim user must be in group lims-interim-repo")
        self.assertLess(g[0]["i"], u[0]["i"], "group before user")
        self.assertNotRegex(u[0]["text"], r'"groups?": "[^"]*\bops\b', "interim account must not join the human ops group")

    def test_sshd_allowgroups_lets_the_interim_group_in(self):
        allow = re.findall(r"(?m)^\s*AllowGroups\s+(.+?)\s*$", self.sshd())
        self.assertEqual(len(allow), 1, "exactly one global AllowGroups line")
        self.assertEqual(sorted(allow[0].split()), ["lims-interim-repo", "ops"], "AllowGroups ops lims-interim-repo")

    def test_sshd_match_block_chroots_and_forces_sftp(self):
        s = self.sshd()
        m = re.search(r"(?ms)^Match User lims-interim-repo\s*$(.*)", s)
        self.assertTrue(m, "Match User lims-interim-repo block")
        blk = m.group(1)
        self.assertRegex(blk, r"(?m)^\s*ChrootDirectory\s+(%s|%%h)\s*$" % re.escape(self.CHROOT))
        self.assertRegex(blk, r"(?m)^\s*ForceCommand\s+internal-sftp\s*$")
        self.assertRegex(blk, r"(?m)^\s*AllowTcpForwarding\s+no\s*$")
        self.assertNotRegex(s[:m.start()], r"(?m)^\s*Match\b", "only this one Match block")
        for k in ("ClientAliveInterval", "MaxAuthTries", "AllowGroups"):  # Match swallows every later line
            self.assertIn(k, s[:m.start()], "global directive %s must come BEFORE the Match block" % k)

    def test_chroot_dir_is_root_owned_and_repo_subdir_is_writable(self):
        t = self.ops_tasks()
        user_i = [e["i"] for e in t if module(e["task"]) == "user"]
        self.assertTrue(user_i)
        root = [e for e in t if module(e["task"]) == "file" and re.search(r'"(path|dest)": "\{\{ dr_repo_home \}\}"|%s"' % re.escape(self.CHROOT), e["text"])
                and '"owner": "root"' in e["text"] and re.search(r'"mode": "0?755"', e["text"])]
        self.assertTrue(root, "chroot dir task: owner root, mode 0755 (sshd refuses a non-root-owned or writable chroot)")
        self.assertGreater(root[-1]["i"], user_i[0], "chmod/chown after the user task (create_home makes it user-owned)")
        sub = [e for e in t if module(e["task"]) == "file" and re.search(r"/repo\"|\}\}/repo", e["text"])
               and re.search(r'"owner": "\{\{ dr_repo_user \}\}"|"owner": "lims-interim-repo"', e["text"])]
        self.assertTrue(sub, "repo/ subdir owned by the interim user")

    def test_repo1_path_is_chroot_relative(self):
        m = re.search(r"repo1-path=(\S+)", read(PLAYBOOK))
        self.assertTrue(m, "repo1-path")
        self.assertRegex(m.group(1), r"^/repo/", "inside the chroot the path is /repo/... (not the host path)")
        self.assertNotIn("/srv/lims/interim-repo", m.group(1))

    def test_sshd_validated_and_reloaded_on_the_repo_host(self):
        t = self.ops_tasks()
        self.assertTrue([e for e in t if re.search(r"sshd\s*(\"|',|,)?\s*-t|sshd.{0,20}-t\b", e["text"])] or
                        [e for e in t if "sshd -t" in e["text"]], "sshd -t before reload (lockout guard, as T-03)")
        r = [e for e in t if re.search(r"(?i)(ssh|sshd)\b.{0,80}(reload|restart)|(reload|restart).{0,80}\bssh", e["text"])]
        self.assertTrue(r, "sshd reloaded so the Match block is live")


class InterimPassEscrow(unittest.TestCase):
    """Review item 2: the interim cipher pass must survive loss of the promoted host: it is escrowed in the
    encrypted secrets store (sops, runbooks/secrets.md) from the control host, reused on a rerun, and never held in
    plaintext on a host of group ops."""

    def escrow(self):
        return [e for e in entries()
                if "sops" in e["text"] and re.search(r"interim.{0,40}(cipher|pass)|(cipher|pass).{0,40}interim", e["text"], re.I)]

    def test_pass_is_written_to_the_encrypted_store_from_the_control_host(self):
        w = [e for e in self.escrow() if "dr_interim_pass" in e["text"]]
        self.assertTrue(w, "a task stores dr_interim_pass with sops (secrets.md: values live only in the encrypted file)")
        for e in w:
            self.assertIn('"delegate_to": "localhost"', e["text"], "escrow runs on the control host, not on dr/ops")
            self.assertTrue(e["no_log"], "escrow task needs no_log")
            self.assertNotIn("ansible.builtin.copy", e["text"])
            self.assertNotIn("ansible.builtin.lineinfile", e["text"])
            self.assertNotRegex(e["text"], r">\s*\S+\.(ya?ml|txt|conf|pass)|tee ", "no plaintext redirect")

    def test_escrow_happens_before_the_pass_lands_on_the_promoted_host(self):
        w = [e for e in self.escrow() if "dr_interim_pass" in e["text"]]
        inc = [e for e in entries() if "repo1-cipher-pass=" in e["text"]]
        self.assertTrue(w and inc)
        self.assertLess(w[0]["i"], inc[0]["i"], "escrow first, then render: a crash in between must not lose the pass")

    def test_rerun_reuses_the_escrowed_pass(self):
        gen = [e for e in entries() if re.search(r"lookup\('password'|password_hash|openssl rand|urandom", e["text"])]
        self.assertTrue(gen, "pass generation task")
        reads = [e for e in entries() if re.search(r"sops.{0,80}(-d\b|--decrypt|--extract)|community\.sops\.sops|lookup\('community\.sops", e["text"])
                 and re.search(r"interim", e["text"], re.I)]
        self.assertTrue(reads, "a task reads an existing escrow entry (sops decrypt/extract) ...")
        self.assertLess(reads[0]["i"], gen[0]["i"], "... BEFORE a new pass is generated")
        self.assertTrue(gen[0]["when"] or "default(" in gen[0]["text"],
                        "generation is conditional: a rerun must not overwrite the escrowed pass")

    def test_no_plaintext_pass_reaches_an_ops_host(self):
        for e in entries():
            if e["host"] == "ops":
                self.assertNotIn("dr_interim_pass", e["text"], "ops play must not see the pass: %s" % e["task"].get("name"))
        for e in entries():  # any file-writing task that carries the pass must run on dr, tmpfs only
            if "dr_interim_pass" in e["text"] and module(e["task"]) in ("copy", "template", "lineinfile", "blockinfile"):
                self.assertEqual(e["host"], "dr")
                self.assertRegex(e["text"], r"dr_secret_dir|/run/lims/secrets", "plaintext pass only on tmpfs")
                self.assertNotIn('"delegate_to"', e["text"], "never delegated to another host")

    def test_runbook_says_where_the_pass_lives_and_how_restore_gets_it(self):
        b = RunbookContent().heads().get("interim-repo", "")
        for p in (r"sops|encrypted (secrets )?(store|file)", r"secrets\.md", r"restore", r"escrow|control host|off the (dr|promoted) host"):
            self.assertRegex(b, re.compile(p, re.I))
        self.assertNotRegex(b, r"(?i)tmpfs only|lost (on|after) (a )?reboot is accepted|never leaves the promoted host",
                            "the old 'pass only on dr tmpfs' text must be gone")


class Repo2ArchiveConflict(unittest.TestCase):
    """Review item 3: 03-APP-FLOW s11.1 ('archive to repo2 continues from dr-1') vs 02-TRD s9 ('repo2's host never holds
    any cipher pass') + T-12 (standby has no pgBackRest). Either the playbook archives to repo2 too (repo2-* from the
    secrets store, via a tmpfs include) or a blocking CR names the conflict, and then the runbook must not claim a
    seed from repo2."""

    CR_DIR = ROOT / ".orchestra" / "cr"

    def has_repo2(self):
        return re.search(r"repo2-", read(PLAYBOOK)) is not None

    def cr(self):
        return [p for p in self.CR_DIR.glob("C1.T-29*.md") if not p.name.endswith(".nonblocking.md")] if self.CR_DIR.is_dir() else []

    def test_repo2_archiving_or_a_blocking_cr(self):
        if self.has_repo2():
            t = read(PLAYBOOK)
            self.assertRegex(t, r"repo2-type=|repo2-host=|repo2-path=")
            for e in find(r"repo2-"):
                self.assertTrue(e["no_log"], "repo2 settings carry a pass: no_log (%s)" % e["task"].get("name"))
            self.assertNotRegex(t, r"repo2-cipher-pass=[^\s{]", "repo2 pass comes from the secrets store, never literal")
        else:
            c = self.cr()
            self.assertTrue(c, "no repo2-* in the playbook: raise a blocking CR .orchestra/cr/C1.T-29.md (s11.1 vs s9)")
            t = c[0].read_text(encoding="utf-8")
            self.assertRegex(t, r"(?s)11\.1.*\b(s|§)?\s*9\b|\b9\b.*11\.1", "CR names 03 s11.1 and 02-TRD s9")

    def test_switch_back_does_not_seed_from_a_repo_nobody_writes(self):
        b = RunbookContent().heads().get("switch-back", "")
        if not self.has_repo2():
            self.assertNotRegex(b, r"(?i)(seed|from)[^.\n]{0,60}repo2", "promoted dr-1 does not archive to repo2 here")
            self.assertRegex(b, r"(?i)interim repo|fresh backup", "seed from the interim repo or a fresh backup taken after promotion")


class GameDayRecord(unittest.TestCase):
    """The staging game day is run by humans (done_when) and cannot be faked by an agent: its record
    infra/runbooks/gameday-log/<YYYY-MM-DD>-dr-promotion.md is shape-checked WHEN IT EXISTS (absence = not yet run, listed
    as NOT proven in the notes; never invent numbers). The site-failover tabletop (AC-22.2) is a desk walk-through like
    tabletop-log/2026-11-08-credential-exposure.md and MUST exist."""

    KEYS = ["Date", "Environment", "Scenario", "Participants", "Promotion started", "Application reconnected",
            "RTO measured", "RTO target", "Interim repo check", "Interim repo host", "NoOffsiteArchive fired", "NoOffsiteArchive still firing at",
            "Actions", "Next game day"]

    def records(self, d, suffix):
        return sorted(p for p in d.glob("*.md") if suffix in p.name) if d.is_dir() else []

    def test_dr_promotion_game_day_record_shape_when_present(self):
        for rec in self.records(GAMEDAYS, "dr-promotion"):
            t = rec.read_text(encoding="utf-8")
            for k in self.KEYS:
                self.assertRegex(t, r"(?m)^- %s:\s*\S" % re.escape(k), "%s: key missing/empty: %s" % (rec.name, k))
            self.assertRegex(t, r"(?mi)^- Environment:\s*staging")
            self.assertRegex(t, r"(?mi)^- RTO measured:.*\d", "RTO must be a measured number")
            self.assertRegex(t, r"(?mi)^- Interim repo check:\s*(passed|ok)")
            self.assertRegex(t, r"(?mi)^- NoOffsiteArchive fired:\s*yes")

    def test_site_failover_tabletop_record_exists(self):
        recs = self.records(TABLETOPS, "site-failover")
        self.assertTrue(recs, "no tabletop record infra/runbooks/tabletop-log/<YYYY-MM-DD>-site-failover.md (AC-22.2)")
        t = recs[-1].read_text(encoding="utf-8")
        for p in (r"(?m)^- Date:\s*\d{4}-\d{2}-\d{2}", r"(?mi)^- Scenario:.*synthetic", r"(?mi)RTO", r"(?mi)registry mirror",
                  r"(?mi)DNS", r"(?m)^- Next (tabletop|game day):\s*\d{4}-\d{2}-\d{2}"):
            self.assertRegex(t, p)


if __name__ == "__main__":
    unittest.main()
