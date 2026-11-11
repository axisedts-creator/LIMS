"""T-27 tests (tester role): secret rotation playbook + per-secret runbook + AC-19.2 load probe.

Covers 06-PLAN row T-27 (done_when: DB password rotation with zero failed requests; JWT/Storage key procedures
documented and dry-run in staging; tests: AC-19.2 load test), AC-19.2, 02-TRD s8.5, 03-APP-FLOW s10, 04-UI-UX s4
(`secrets.md` catalogue) and s7 command table, 07-SECURITY REQ-SEC-128 / REQ-SEC-035 / REQ-SEC-140.
LD-45: group names only (`localhost`, `ops`, `data`, `app`); no literal host names; the playbook cites LD-45.

NOT provable here (no ansible, sops, docker, Postgres): a real rotation, the real 5-minute zero-failure result
(live: infra/tests/integration/test_t27_live.py, LIMS_T27_LIVE=1), a real staging dry-run. These tests prove the
committed artefacts: structure, validation matrix (Jinja2), ordering, secret hygiene, the load probe itself.

CONTRACTS where the spec is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ansible/playbooks/rotate-secret.yml: YAML list of plays; each play `hosts` in {localhost, ops, data, app};
   every non-localhost play `become: true`. Input extra-var `secret_id` (one id per run, 02-TRD s8.5). Validation
   (ansible.builtin.assert / ansible.builtin.fail with `when`, evaluated here with plain Jinja2) runs BEFORE any
   state change: secret_id must be defined and match ^[a-z][a-z0-9_]*$; the playbook also reads
   infra/secrets/schema/<env>.secrets.schema.yaml (id must exist there). Ids with a MANUAL procedure are refused
   (fail message names `secrets.md#<anchor>`): the JWT family (JWT_SECRET ANON_KEY SERVICE_ROLE_KEY JWT_KEYS JWT_JWKS
   SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY lims_core_jwt_key), core_storage_service_key,
   pgbackrest_repo1_cipher_pass, pgbackrest_repo2_cipher_pass, wireguard_private_keys, luks_keyfiles, payments_kek.
   Automated: lims_api_password (role lims_api -> consumers api-a, api-b) and lims_worker_password (role lims_worker
   -> worker-a, + worker-b only when topology_profile == 'full').
 * DB password flow (order matters): ops_audit start note -> start synthetic load (async, BEFORE the first change) ->
   generate new value (CSPRNG, >= 32 chars, no_log) -> ALTER ROLE <role> PASSWORD via
   `docker exec -i supabase-db ... psql -X ... -v ON_ERROR_STOP=1` with the SQL on STDIN (never argv), no_log, and a
   leading `SET log_min_error_statement` (a failing ALTER would otherwise log the password) -> persist the new value
   (sops set on localhost, no_log, argv form) -> re-render secrets (`secrets_render`) -> rolling recreate: one task per
   consumer, api-a BEFORE api-b, each `docker compose ... up -d --no-deps --force-recreate --wait` (plain `up -d`
   does nothing: the compose config does not change, only the secret file) -> wait for the load job and fail unless
   it reports zero failures -> ops_audit end note. Consumers are never recreated in one command, never `restart`.
 * Load (AC-19.2): infra/tests/internal/rotation_load.py --duration 300 against a URL containing
   /v1/core/health/ready, started with `async:` + `poll: 0` (or equivalent background) before the ALTER ROLE and
   collected with async_status; its exit code gates the play. Duration is >= 300 s.
 * Fail safe: the state-changing part sits in a `block:` whose `rescue:` re-applies ALTER ROLE (old value), writes an
   ops_audit note and ends with ansible.builtin.fail (never rc 0 after a half rotation).
 * Hygiene: every task that handles a value (generate/ALTER/sops/render) has no_log (own or block); ops_audit notes via
   `ansible.builtin.command` + `argv` (never a shell string), never contain the value; no `debug` prints a value; no
   `--password` / `PGPASSWORD=<literal>` on a command line; sops never writes plaintext to a file.
 * infra/runbooks/secrets.md: level-2 headings (GitHub slugs) rotation, db-passwords, jwt-signing-keys,
   storage-signing-key, bff-keys, payments-kek, pgbackrest-cipher-pass, wireguard-keys, luks-keys, offboarding,
   suspected-exposure, dry-run-in-staging; content checks in RunbookContent. No secret values, no real names.
Stdlib + PyYAML + Jinja2. Missing file = FAIL (never skip). Run from repo root:
  python -B -m unittest discover -s infra/tests/static -p "test_t27_*.py" -v
"""
import json
import re
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
PLAYBOOK = ROOT / "infra" / "ansible" / "playbooks" / "rotate-secret.yml"
RUNBOOK = ROOT / "infra" / "runbooks" / "secrets.md"
LOAD = ROOT / "infra" / "tests" / "internal" / "rotation_load.py"
SCHEMA = ROOT / "infra" / "secrets" / "schema" / "{}.secrets.schema.yaml"

HOSTNAMES = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|staging-1|dev-1)\b")
KEYWORDS = {
    "name", "when", "register", "no_log", "become", "become_user", "vars", "loop", "with_items", "loop_control",
    "delegate_to", "changed_when", "failed_when", "tags", "notify", "args", "environment", "ignore_errors", "retries",
    "delay", "until", "check_mode", "run_once", "any_errors_fatal", "throttle", "timeout", "diff", "listen",
    "async", "poll", "run_once",
}
MANUAL = ["JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY", "JWT_KEYS", "JWT_JWKS", "SUPABASE_PUBLISHABLE_KEY",
          "SUPABASE_SECRET_KEY", "lims_core_jwt_key", "core_storage_service_key", "pgbackrest_repo1_cipher_pass",
          "pgbackrest_repo2_cipher_pass", "wireguard_private_keys", "luks_keyfiles", "payments_kek"]
AUTOMATED = {"lims_api_password": ("lims_api", ["api-a", "api-b"]), "lims_worker_password": ("lims_worker", ["worker-a"])}


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
for _n in ("match", "search", "regex"):
    _J.tests[_n] = (lambda f: (lambda v, p: f(p, str(v)) is not None))(re.match if _n == "match" else re.search)
_J.filters["bool"] = lambda v: v if isinstance(v, bool) else str(v).strip().lower() in ("1", "true", "yes", "on")


def ev(expr, ctx):
    return _J.compile_expression(str(expr))(**ctx)


def first_change_index():
    """Index of the first task that is neither an assert/fail/set_fact/stat/include_vars/slurp/debug-less check."""
    for e in entries():
        if module(e["task"]) not in ("assert", "fail", "set_fact", "stat", "include_vars", "slurp", "meta"):
            return e["i"]
    return len(entries())


def find(pattern, es=None, flags=re.I):
    return [e for e in (es if es is not None else entries()) if re.search(pattern, e["text"], flags)]


class PlaybookShape(unittest.TestCase):
    def test_plays_use_group_names_with_become(self):
        for p in load_plays():
            self.assertIn(p.get("hosts"), ("localhost", "ops", "data", "app"), "play hosts: group names only (LD-45)")
            if p.get("hosts") != "localhost":
                self.assertTrue(p.get("become"), "become: true required on host plays")

    def test_no_host_names_and_cites_ld45(self):
        text = read(PLAYBOOK)
        self.assertIsNone(HOSTNAMES.search(text), "literal host name in playbook")
        self.assertIn("LD-45", text)

    def test_reads_the_env_schema(self):
        self.assertIn("secrets.schema.yaml", read(PLAYBOOK), "secret_id must be checked against the env schema")

    def test_all_three_envs_have_the_automated_ids(self):  # the playbook is only as good as its ids
        for env in ("dev", "staging", "prod"):
            ids = {s["id"] for s in yaml.safe_load(read(Path(str(SCHEMA).format(env))))["secrets"]}
            for i in list(AUTOMATED) + MANUAL:
                self.assertIn(i, ids, "%s missing in %s schema" % (i, env))


class Validation(unittest.TestCase):
    """Evaluate every assert/fail the playbook runs BEFORE its first state change, for a matrix of secret ids."""

    def verdict(self, **ctx):
        ctx.setdefault("env", "staging")
        ctx.setdefault("topology_profile", "lean")
        pre = [e for e in entries() if e["i"] < first_change_index()]
        guards = [e for e in pre if module(e["task"]) in ("assert", "fail")]
        self.assertTrue(guards, "no validation (assert/fail) before the first state change")
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
            else:  # fail: rejects when its `when` holds
                try:
                    if all(ev(c, ctx) for c in e["when"]) and e["when"]:
                        return False
                except Exception:
                    pass
        return True

    @staticmethod
    def skipped(e, ctx):
        for c in e["when"]:
            try:
                if not ev(c, ctx):
                    return True
            except Exception:
                pass
        return False

    def test_automated_ids_accepted(self):
        for i in AUTOMATED:
            self.assertTrue(self.verdict(secret_id=i), i)

    def test_missing_or_blank_id_rejected(self):
        self.assertFalse(self.verdict())
        for v in ("", " ", None):
            self.assertFalse(self.verdict(secret_id=v), repr(v))

    def test_malformed_ids_rejected(self):  # injection / path traversal / case tricks
        for v in ("lims_api_password; DROP ROLE x", "lims_api_password\n", "../lims_api_password", "lims api",
                  "LIMS_API_PASSWORD", "lims_api_password'", "$(id)", "a" * 0, "1abc", "lims_api_password,lims_worker_password"):
            self.assertFalse(self.verdict(secret_id=v), repr(v))

    def test_manual_procedure_ids_refused_with_runbook_pointer(self):
        for i in MANUAL:
            self.assertFalse(self.verdict(secret_id=i), "%s has a manual procedure: refuse before any change" % i)
        self.assertRegex(read(PLAYBOOK), r"secrets\.md#[a-z0-9-]+", "refusal message must point at a runbook anchor")


class DbPasswordFlow(unittest.TestCase):
    def test_alter_role_via_stdin_with_log_guard(self):
        alter = [e for e in find(r"ALTER ROLE") if module(e["task"]) == "command"]
        self.assertTrue(alter, "no ALTER ROLE command task")
        for e in alter:
            t = e["task"]
            body = t[next(k for k in t if k.endswith("command"))]
            cmd = body["cmd"] if isinstance(body, dict) and "cmd" in body else json.dumps(body)
            self.assertIn("docker exec -i", cmd)
            self.assertIn("psql", cmd)
            self.assertIn("ON_ERROR_STOP=1", cmd)
            self.assertNotRegex(cmd, r"ALTER ROLE|PASSWORD '|new_pw|new_value", "password/SQL must travel on stdin, not argv")
            stdin = str(body.get("stdin", "") if isinstance(body, dict) else t.get("stdin", ""))
            self.assertIn("ALTER ROLE", stdin)
            self.assertIn("log_min_error_statement", stdin, "a failing ALTER logs its text: SET log_min_error_statement first")
            self.assertTrue(e["no_log"], "ALTER ROLE task needs no_log")

    def test_role_derived_from_id_not_a_free_value(self):
        t = read(PLAYBOOK)
        self.assertIn("lims_api", t)
        self.assertIn("lims_worker", t)

    def test_new_value_generated_strongly_and_hidden(self):
        gen = [e for e in find(r"lookup\(.(ansible\.builtin\.)?password|password\(|random_string|openssl rand|secrets\.(token|choice)|secrets_generate|/dev/urandom")
               if module(e["task"]) != "assert"]
        self.assertTrue(gen, "no CSPRNG generation task")
        self.assertTrue(all(e["no_log"] for e in gen), "generation tasks need no_log")
        self.assertFalse(find(r"ansible_date_time|md5|now\(|random\(\)", gen), "weak/seeded randomness")
        self.assertTrue(any(re.search(r"\b(3[2-9]|[4-9]\d|\d{3,})\b", e["text"]) for e in gen), ">= 32 chars of entropy")

    def test_order_audit_load_generate_alter_persist_render_roll_wait(self):
        def idx(pattern, mod=None):
            r = [e["i"] for e in find(pattern) if e["section"] != "rescue" and (mod is None or module(e["task"]) == mod)]
            self.assertTrue(r, "no task matching %r" % pattern)
            return min(r)
        start_note = idx(r"ops-note|ops_note", "command")
        load = idx(r"rotation_load\.py")
        alter = idx(r"ALTER ROLE", "command")
        persist = idx(r"sops")
        render = idx(r"secrets_render")
        api_a = idx(r"force-recreate[^\"]*\bapi-a\b|\bapi-a\b[^\"]*force-recreate")
        api_b = idx(r"force-recreate[^\"]*\bapi-b\b|\bapi-b\b[^\"]*force-recreate")
        wait = idx(r"async_status")
        self.assertLess(start_note, alter)
        self.assertLess(load, alter, "the synthetic load must already run when the password changes")
        self.assertLess(alter, persist)
        self.assertLess(persist, render)
        self.assertLess(render, api_a)
        self.assertLess(api_a, api_b, "rolling: api-a healthy before api-b is touched")
        self.assertLess(api_b, wait)

    def test_rolling_recreate_one_consumer_per_command_and_waits(self):
        rolls = [e for e in find(r"docker compose") if re.search(r"\bup\b", e["text"])]
        self.assertTrue(rolls)
        for e in rolls:
            self.assertIn("--force-recreate", e["text"], "plain `up -d` is a no-op when only the secret file changed")
            self.assertIn("--wait", e["text"])
            self.assertIn("--no-deps", e["text"])
            named = [s for s in ("api-a", "api-b", "worker-a", "worker-b") if re.search(r"(?<![\w-])%s(?![\w-])" % s, e["text"])]
            self.assertEqual(len(named), 1, "one consumer per command (rolling): %s" % named)
        self.assertFalse(find(r"docker (compose )?restart|docker compose[^\"]* restart"), "use `up --force-recreate` per consumer, not restart")
        self.assertFalse(find(r"\bdown\b[^\"]*(api|worker)"), "never take all consumers down")

    def test_worker_b_only_in_full_profile(self):
        wb = [e for e in find(r"worker-b") if "up" in e["text"] and "force-recreate" in e["text"]]
        for e in wb:
            self.assertTrue(any("full" in str(c) for c in e["when"]), "worker-b exists only in the full profile (LD-45)")

    def test_persist_with_sops_no_plaintext_on_disk(self):
        sops = [e for e in find(r"\bsops\b") if module(e["task"]) in ("command", "shell")]
        self.assertTrue(sops)
        for e in sops:
            self.assertTrue(e["no_log"])
            self.assertEqual(module(e["task"]), "command", "no shell string around sops")
            self.assertNotRegex(e["text"], r"--output|\btee\b|> */|\.dec\b|/tmp/", "plaintext must not touch disk")
        self.assertTrue(any(re.search(r"--set|set\b", e["text"]) for e in sops), "sops --set (03-APP-FLOW s10)")

    def test_rescue_restores_and_fails(self):
        resc = [e for e in entries() if e["section"] == "rescue"]
        self.assertTrue(resc, "state-changing part needs a block/rescue")
        self.assertTrue(find(r"ALTER ROLE", resc), "rescue must put the old password back")
        self.assertTrue(find(r"ops-note|ops_note", resc), "rescue must leave an ops_audit note")
        self.assertEqual(module(resc[-1]["task"]), "fail", "rescue ends with ansible.builtin.fail")
        self.assertTrue(all(e["no_log"] for e in find(r"ALTER ROLE", resc)))

    def test_rescue_render_failure_must_not_abort_the_rescue(self):
        # ignore_errors on a dynamic include_role covers only the include; apply.ignore_errors covers the role's tasks
        incl = [e for e in entries() if e["section"] == "rescue" and module(e["task"]) == "include_role"]
        self.assertTrue(incl, "rescue re-renders secrets via include_role")
        for e in incl:
            t = e["task"]
            args = next(v for k, v in t.items() if k not in KEYWORDS)
            self.assertIs(t.get("ignore_errors"), True, "include_role itself ignore_errors: true")
            self.assertIsInstance(args, dict)
            self.assertIs((args.get("apply") or {}).get("ignore_errors"), True,
                          "include_role apply: {ignore_errors: true} so a failing secrets_render task cannot skip the "
                          "RESTORE FAILED note and the final message")


class LiveCommand(unittest.TestCase):
    """The live AC-19.2 test must pass every input the playbook's 'Inputs of the DB flow are present' assert needs."""
    ENV = {"LIMS_T27_INVENTORY": "infra/ansible/inventories/staging/hosts.yml", "LIMS_T27_ENV": "staging",
           "LIMS_T27_ENC_FILE": "/srv/lims-secrets/staging.enc.yaml", "LIMS_T27_PROBE_BASE": "https://staging.invalid",
           "LIMS_T27_COMPOSE_ENV": '{"APP_WG_IP": "10.0.0.1"}', "LIMS_T27_CA_FILE": "/etc/ca.pem"}

    def cmd_vars(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("t27_live", ROOT / "infra" / "tests" / "integration" / "test_t27_live.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        cmd = mod.playbook_cmd(self.ENV)
        out = {}
        for i, a in enumerate(cmd):
            if a == "-e":
                v = cmd[i + 1]
                out.update(json.loads(v) if v.startswith("{") else dict([v.split("=", 1)]))
        return cmd, out

    def test_command_line_carries_every_required_input(self):
        play_vars = {}
        for p in load_plays():
            play_vars.update(p.get("vars") or {})
        gate = [e for e in find(r"Inputs of the DB flow are present") if module(e["task"]) == "assert"]
        self.assertTrue(gate, "playbook asserts its DB-flow inputs")
        required = set(re.findall(r"\b(rotate_\w+)\s*\|\s*length", json.dumps(gate[0]["task"]["ansible.builtin.assert"]["that"])))
        self.assertTrue(required)
        cmd, given = self.cmd_vars()
        for var in sorted(required):
            alias = re.search(r"\b(secrets_render_\w+)\b", str(play_vars.get(var, "")))  # e.g. rotate_enc_file <- secrets_render_enc_file
            self.assertIn(alias.group(1) if alias else var, given, "live command must set -e for %s" % var)
        self.assertTrue(given.get("rotate_compose_env"), "rotate_compose_env is a non-empty dict")
        self.assertEqual(given.get("rotate_probe_ca_file"), "/etc/ca.pem")

    def test_inventory_resolved_from_repo_root(self):
        cmd, _ = self.cmd_vars()
        inv = Path(cmd[cmd.index("-i") + 1])
        self.assertTrue(inv.is_absolute())
        self.assertEqual(inv, (ROOT / self.ENV["LIMS_T27_INVENTORY"]).resolve())


class LoadGate(unittest.TestCase):
    def test_load_started_in_background_and_collected(self):
        started = find(r"rotation_load\.py")
        self.assertTrue(started)
        self.assertTrue(any(("async" in e["task"] and e["task"].get("poll") == 0) for e in started), "async + poll: 0")
        self.assertTrue(find(r"async_status"), "result must be collected")
        txt = "\n".join(e["text"] for e in started)
        self.assertIn("/v1/core/health/ready", txt)
        m = re.search(r"--duration[\"', ]+(\d+)", txt)
        self.assertTrue(m and int(m.group(1)) >= 300, "synthetic load must cover >= 300 s (AC-19.2)")

    def test_load_result_gates_the_play(self):
        gate = [e for e in find(r"async_status|\.failed|\.rc\b|failed_when|assert") if e["i"] > min(e["i"] for e in find(r"rotation_load\.py"))]
        self.assertTrue(any(re.search(r"\.rc|\.failed|failed_when|failed\s*==|\"failed\"", e["text"]) for e in gate),
                        "a non-zero load exit must fail the play")


class Hygiene(unittest.TestCase):
    def test_ops_audit_notes_are_argv_and_value_free(self):
        notes = [e for e in find(r"ops-note|ops_note") if module(e["task"]) in ("command", "shell")]
        self.assertGreaterEqual(len(notes), 2, "start and end note at least")
        for e in notes:
            self.assertEqual(module(e["task"]), "command")
            body = e["task"][next(k for k in e["task"] if k.endswith("command"))]
            self.assertTrue(isinstance(body, dict) and "argv" in body, "argv form only (ids/refs are untrusted text)")
            self.assertNotRegex(e["text"], r"new_pw|new_value|rotate_new|\bpassword\b[^\"]*\{\{", "a note must not carry the value")

    def test_no_debug_of_values_and_no_secret_on_cmdline(self):
        for e in find(r"\bdebug\b"):
            if module(e["task"]) == "debug":
                self.assertNotRegex(e["text"], r"new_|password|secret", "debug must not print values")
        self.assertFalse(find(r"--password|PGPASSWORD=[^\\\"$ ']"), "no literal password on a command line")

    def test_every_value_task_hidden(self):
        for e in find(r"ALTER ROLE|sops|secrets_generate|lookup\(.(ansible\.builtin\.)?password|random_string|openssl rand"):
            if module(e["task"]) in ("assert", "fail", "include_role", "debug"):
                continue
            self.assertTrue(e["no_log"], "no_log missing: %s" % e["text"][:120])


class RunbookContent(unittest.TestCase):
    @staticmethod
    def slug(h):
        s = re.sub(r"[^\w\- ]", "", h.strip().lower().replace("`", ""))
        return s.replace(" ", "-")

    def sections(self):
        text, cur, out = read(RUNBOOK), None, {}
        for ln in text.splitlines():
            m = re.match(r"^##\s+(.+?)\s*$", ln)
            if m:
                cur = self.slug(m.group(1))
                out[cur] = ""
            elif cur:
                out[cur] += ln + "\n"
        return out

    def test_required_sections(self):
        have = self.sections()
        for s in ("rotation", "db-passwords", "jwt-signing-keys", "storage-signing-key", "bff-keys", "payments-kek",
                  "pgbackrest-cipher-pass", "wireguard-keys", "luks-keys", "offboarding", "suspected-exposure",
                  "dry-run-in-staging"):
            self.assertIn(s, have, "missing `## ...` heading with slug %s" % s)

    def test_rotation_and_db_section(self):
        s = self.sections()
        self.assertRegex(s["rotation"], r"rotate-secret\.yml\s+-e\s+secret_id=")
        self.assertRegex(s["rotation"], r"180\s*d")
        self.assertRegex(s["rotation"], r"365\s*d")
        db = s["db-passwords"]
        for w in ("lims_api_password", "ALTER ROLE", "rolling", "AC-19.2", "300"):
            self.assertIn(w, db)
        self.assertRegex(db, r"(?i)zero failed|no failed|0 failed")

    def test_jwt_section(self):
        t = self.sections()["jwt-signing-keys"]
        for w in ("JWT_SECRET", "lims_core_jwt_key", "overlap"):
            self.assertIn(w, t)
        self.assertRegex(t, r"(?i)dual|old \+ new|both keys")
        self.assertRegex(t, r"(?i)remove (the )?old")
        self.assertRegex(t, r"C2|C0")

    def test_storage_section(self):
        t = self.sections()["storage-signing-key"]
        self.assertIn("core_storage_service_key", t)
        self.assertRegex(t, r"(?i)invalidat\w+ (all )?(existing |outstanding )?signed")
        self.assertIn("REQ-SEC-035", t)

    def test_bff_payments_cipher_luks_wg(self):
        s = self.sections()
        self.assertIn("LIMS_CORE_BFF_KEY_FILES", s["bff-keys"])
        for w in ("payments.rewrap_credentials", "active"):
            self.assertIn(w, s["payments-kek"])
        self.assertRegex(s["pgbackrest-cipher-pass"], r"(?i)cannot be changed")
        self.assertRegex(s["pgbackrest-cipher-pass"], r"(?i)new (repo|stanza)")
        self.assertRegex(s["pgbackrest-cipher-pass"], r"(?i)full backup")
        self.assertIn("luksAddKey", s["luks-keys"])
        self.assertIn("luksRemoveKey", s["luks-keys"])
        self.assertRegex(s["luks-keys"], r"luksAddKey[\s\S]*luksRemoveKey")  # add BEFORE remove: no lock-out
        self.assertRegex(s["wireguard-keys"], r"site\.yml")

    def test_offboarding_and_exposure(self):
        s = self.sections()
        self.assertRegex(s["offboarding"], r"REQ-SEC-140")
        self.assertRegex(s["offboarding"], r"(?i)1 business day|one business day")
        self.assertRegex(s["suspected-exposure"], r"(?i)immediately")
        self.assertRegex(s["suspected-exposure"], r"incident-response\.md")

    def test_dry_run_section_records_jwt_and_storage(self):
        t = self.sections()["dry-run-in-staging"]
        self.assertRegex(t, r"(?i)staging")
        self.assertRegex(t, r"(?i)JWT")
        self.assertRegex(t, r"(?i)Storage")
        self.assertRegex(t, r"(?i)Date|Last tested|Result")

    def test_no_value_leaks_and_no_hostnames(self):
        text = read(RUNBOOK)
        self.assertIsNone(HOSTNAMES.search(text), "runbook must not hard-code host names (LD-45)")
        self.assertNotRegex(text, r"eyJ[A-Za-z0-9_-]{20,}", "JWT-looking value in runbook")
        self.assertNotRegex(text, r"(?i)(password|key|token)\s*[:=]\s*['\"]?[A-Za-z0-9+/]{24,}", "value-looking secret")
        self.assertNotRegex(text, r"-----BEGIN ")


class LoadProbe(unittest.TestCase):
    """The AC-19.2 probe itself: it must catch a single failed request and must not hide one."""

    @staticmethod
    def server(handler):
        srv = HTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv

    def run_probe(self, srv, *extra):
        url = "http://127.0.0.1:%d/v1/core/health/ready" % srv.server_port
        r = subprocess.run([sys.executable, "-I", str(LOAD), "--url", url, "--duration", "2", "--rps", "10", "--timeout", "2", *extra],
                           capture_output=True, text=True, timeout=60)
        return r.returncode, (json.loads(r.stdout) if r.stdout.strip() else {}), r.stderr

    def test_all_ok_exit_0(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
            def log_message(self, *a): pass
        srv = self.server(H)
        try:
            rc, out, _ = self.run_probe(srv)
        finally:
            srv.shutdown()
        self.assertEqual(rc, 0, out)
        self.assertGreaterEqual(out["total"], 15)
        self.assertEqual(out["failed"], 0)

    def test_single_500_fails(self):
        hits = {"n": 0}

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                hits["n"] += 1
                self.send_response(500 if hits["n"] == 7 else 200); self.end_headers()
            def log_message(self, *a): pass
        srv = self.server(H)
        try:
            rc, out, _ = self.run_probe(srv)
        finally:
            srv.shutdown()
        self.assertEqual(rc, 1)
        self.assertEqual(out["failed"], 1)
        self.assertIn("HTTP 500", out["first_errors"])

    def test_redirect_is_a_failure(self):
        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(302); self.send_header("Location", "/x"); self.end_headers()
            def log_message(self, *a): pass
        srv = self.server(H)
        try:
            rc, out, _ = self.run_probe(srv)
        finally:
            srv.shutdown()
        self.assertEqual(rc, 1)

    def test_connection_refused_is_failure_and_nothing_sent_is_failure(self):
        srv = self.server(BaseHTTPRequestHandler)
        port = srv.server_port
        srv.shutdown(); srv.server_close()
        r = subprocess.run([sys.executable, "-I", str(LOAD), "--url", "http://127.0.0.1:%d/" % port, "--duration", "1",
                            "--rps", "5", "--timeout", "1"], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 1)
        self.assertEqual(json.loads(r.stdout)["failed"], json.loads(r.stdout)["total"])

    def test_bad_arguments_exit_2(self):
        for args in (["--url", "file:///etc/passwd"], ["--url", "ftp://x/"], ["--url", "http://127.0.0.1:1/", "--duration", "0"],
                     ["--url", "http://127.0.0.1:1/", "--rps", "9999"], ["--url", "not a url"], []):
            r = subprocess.run([sys.executable, "-I", str(LOAD), *args], capture_output=True, text=True, timeout=30)
            self.assertEqual(r.returncode, 2, args)


if __name__ == "__main__":
    unittest.main()
