"""T-08 tests (tester role): DB bootstrap (db-bootstrap.yml) + deploy-time DB flow (deploy.yml, DB part).

Covers 02-TRD s7.9 (steps 1-3), s7.7 (pg_hba: no ops-1 entry), AC-27.1, AC-27.2, 06-PLAN row T-08, 07-SEC row A1
(no standing superuser path; secrets never literal / never logged), LD-45 (both topology profiles; host names are
never hard-coded, tests read groups from the active profile).
Done when (T-08): bootstrap runs once (marker, second run refused); migrations -> registry-sync -> seeds in this order from the
one-shot `migrate` container on the app host; any failure stops the pipeline; a connection from the ops host is rejected by pg_hba.

NOT provable here (needs hosts + docker, see infra/tests/integration/test_t08_live.py, LIMS_T08_LIVE=1): a real psql run of
db/bootstrap/*.sql, the real `pnpm` commands, the real source address seen by Postgres. The static tests prove the playbook
structure with a small evaluator (Jinja `when`/`loop` evaluated for env=prod/staging/dev); there is no ansible on Windows (LD-17).

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * Tasks are INLINE in the two playbooks (no include_tasks/import_tasks) so the order is auditable. Every task has a `name`.
 * Variables available: env, app_db_name, db_primary_wg_ip, groups, hostvars, secrets_render_secrets_dir (+ any other; unknown
   variables are not an error here). Host names are never literal: use groups (`data`, `app`).
 * db-bootstrap.yml: play on group `data`. Order: `stat` of /srv/lims/pg/bootstrap.done (register R) -> `fail`/`assert` that fires
   when R.stat.exists -> psql tasks -> task writing the marker. The marker write is never in rescue/always and never before a psql.
   psql runs inside the db container (`exec`), as a non-lims_* superuser (`-U`), with `-v ON_ERROR_STOP=1`, `-v dbname={{ app_db_name }}`,
   files 00_roles.sql before 01_database.sql, 01 with `-d {{ app_db_name }}`; the six role passwords as `-v lims_<role>_pw=<{{..}}|$..>`
   (or `\\set`): lims_migrator, lims_api, lims_worker, lims_monitor, lims_replicator, lims_audit_ship.
 * deploy.yml: the play that runs the DB steps has hosts on group `app` (never ops/localhost/all), `any_errors_fatal: true`.
   Steps are command/shell tasks `docker compose ... run --rm migrate ...` containing `pnpm db:migrate`, `pnpm worker:registry-sync`
   and a seed step (the seed task is the one whose name or command contains "seed"; the seed runner command name is NOT in the spec,
   UNVERIFIED: writer decides it and records it in .orchestra/notes/T-08-impl.md). Each has `run_once: true`.
   Direct connection `{{ db_primary_wg_ip }}` + 5432 (never PgBouncer 6432), login as lims_migrator, never supabase_admin/postgres.
   Seeds: prod mentions 001, 002, 003 and not 010; staging/dev mention 010 or are unrestricted (`--all`, `db/seeds/*`, `*.sql`).
   A pre-deploy `pgbackrest backup` task is OPTIONAL here (T-24 owns the pipeline); if present: --type=incr --repo=1, prod only, before migrations.
 * A `migrate` service exists in a compose file under infra/compose (db_net, no published ports, not a restart-always service).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t08_*.py" -v
"""
import json
import re
import sys
import unittest
from pathlib import Path

import jinja2
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_t04_postgres_image as t04  # noqa: E402  (module import only: its TestCases are not re-collected)

ROOT = Path(__file__).resolve().parents[3]
PB = ROOT / "infra" / "ansible" / "playbooks"
BOOT = PB / "db-bootstrap.yml"
DEPLOY = PB / "deploy.yml"
COMPOSE = ROOT / "infra" / "compose"
MARKER = "/srv/lims/pg/bootstrap.done"
PW_ROLES = ["lims_migrator", "lims_api", "lims_worker", "lims_monitor", "lims_replicator", "lims_audit_ship"]
HOSTNAME_RE = re.compile(r"\b(data|app|ops|dr|dev|prod|backup|staging)-\d\b")

KEYWORDS = {"name", "when", "register", "no_log", "become", "become_user", "ignore_errors", "ignore_unreachable", "failed_when",
            "changed_when", "run_once", "delegate_to", "delegate_facts", "tags", "vars", "environment", "loop", "with_items",
            "with_fileglob", "with_list", "loop_control", "args", "retries", "delay", "until", "check_mode", "async", "poll",
            "any_errors_fatal", "block", "rescue", "always", "notify", "listen", "throttle", "timeout", "diff", "connection",
            "remote_user", "module_defaults", "collections", "no_log", "debugger", "port"}
CMD_MODULES = ("command", "shell", "raw", "script")


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


JENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)

PROFILES = {  # LD-45: both topology profiles + dev; groups only, no host name is asserted anywhere else
    "full": {"hosts": {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": "10.79.0.14"},
             "groups": {"data": ["data-1"], "app": ["app-1"], "ops": ["ops-1"], "dr": ["dr-1"]}},
    "lean": {"hosts": {"prod-1": "10.79.0.11", "backup-1": "10.79.0.15"},
             "groups": {"data": ["prod-1"], "app": ["prod-1"], "ops": ["prod-1"], "dr": []}},
    "dev": {"hosts": {"dev-1": "10.79.0.11"},
            "groups": {"data": ["dev-1"], "app": ["dev-1"], "ops": ["dev-1"], "dr": []}},
}


def ctx(env="dev", profile="full", **extra):
    p = PROFILES[profile]
    c = {"env": env, "app_db_name": "postgres", "groups": p["groups"], "hostvars": {h: {"wg_ip": ip} for h, ip in p["hosts"].items()},
         "db_primary_wg_ip": p["hosts"][p["groups"]["data"][0]], "inventory_hostname": p["groups"]["app"][0],
         "docker_subnets": dict(t04.SUBNETS), "secrets_render_secrets_dir": "/run/lims/secrets"}
    c.update(extra)
    return c


# ---------- tiny playbook model ----------
def module_of(task):
    for k in task:
        if k not in KEYWORDS:
            return k
    return None


def short(mod):
    return (mod or "").split(".")[-1]


def cmd_of(task):
    """Command line of a command/shell/raw task as one string ('' otherwise)."""
    mod = module_of(task)
    if short(mod) not in CMD_MODULES:
        return ""
    v = task[mod]
    if isinstance(v, str):
        return v
    if isinstance(v, dict):
        if "argv" in v:
            return " ".join(str(a) for a in v["argv"])
        return str(v.get("cmd") or v.get("_raw_params") or "")
    return ""


def blob(task):
    return json.dumps({k: v for k, v in task.items() if k not in ("name", "register", "tags")}, default=str)


def strip_comments(text):
    return "\n".join(re.sub(r"\s#.*$", "", l) if not l.lstrip().startswith("#") else "" for l in text.splitlines())


def load(path):
    if not path.is_file():
        raise AssertionError("missing file %s" % path.relative_to(ROOT).as_posix())
    plays = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(plays, list) or not plays or not all(isinstance(p, dict) and "hosts" in p for p in plays):
        raise AssertionError("%s must be a YAML list of plays, each with `hosts`" % path.name)
    return plays


def flat(tasks, section="tasks", parents=()):
    for t in tasks or []:
        if "block" in t:
            p = parents + (t,)
            yield from flat(t["block"], section, p)
            yield from flat(t.get("rescue"), "rescue", p)
            yield from flat(t.get("always"), "always", p)
        else:
            yield t, section, parents


def items_of(plays):
    out = []
    for pi, play in enumerate(plays):
        for key in ("pre_tasks", "tasks", "post_tasks"):
            for t, section, parents in flat(play.get(key)):
                out.append({"task": t, "section": section, "parents": parents, "play": play, "pi": pi, "idx": len(out)})
    return out


def conds(item):
    out = []
    for src in list(item["parents"]) + [item["task"]]:
        w = src.get("when")
        if w is None:
            continue
        out.extend(w if isinstance(w, list) else [w])
    return out


def ev(expr, c):
    if isinstance(expr, bool):
        return expr
    e = str(expr).strip()
    m = re.fullmatch(r"\{\{\s*(.*?)\s*\}\}", e, re.S)
    e = m.group(1) if m else e
    try:
        return bool(JENV.compile_expression(e)(**c))
    except Exception as ex:  # noqa: BLE001
        raise AssertionError("test evaluator cannot evaluate when/that %r (%s); use plain Jinja comparisons" % (expr, ex))


def active(item, c):
    return all(ev(w, c) for w in conds(item))


def render_any(v, c):
    if isinstance(v, str):
        return JENV.from_string(v).render(**c)
    if isinstance(v, list):
        return [render_any(x, c) for x in v]
    if isinstance(v, dict):
        return {k: render_any(x, c) for k, x in v.items()}
    return v


def rendered_cmds(item, c):
    """Rendered command strings of an item (one per loop element), [] when its `when` is false."""
    if not active(item, c):
        return []
    t = item["task"]
    base = cmd_of(t)
    loop = t.get("loop", t.get("with_items"))
    if loop is None:
        return [render_any(base, c)]
    seq = render_any(loop, c) if isinstance(loop, list) else JENV.from_string(str(loop)).render(**c)
    if isinstance(seq, str):
        try:
            seq = eval(seq, {"__builtins__": {}}, {})  # noqa: S307  (test-only: renders a Python-literal list)
        except Exception:  # noqa: BLE001
            raise AssertionError("loop %r is not a literal list after rendering; keep loops literal for auditability" % loop)
    return [JENV.from_string(base).render(item=i, **c) for i in seq]


def with_marker(item):
    return MARKER in blob(item["task"])


def psql_items(items):
    return [i for i in items if re.search(r"\bpsql\b", cmd_of(i["task"]) + " " + blob(i["task"]))]


# ====================================================================================================
class BootstrapTest(unittest.TestCase):
    """AC-27.1: db/bootstrap/*.sql once, as the provisioning superuser, passwords from the secret store, marker blocks re-run."""

    @classmethod
    def setUpClass(cls):
        cls.plays = load(BOOT)
        cls.items = items_of(cls.plays)
        cls.text = BOOT.read_text(encoding="utf-8")

    def test_every_task_is_inline_and_named(self):
        self.assertTrue(self.items, "no tasks in db-bootstrap.yml")
        for i in self.items:
            self.assertNotIn(short(module_of(i["task"])), ("include_tasks", "import_tasks", "include_role", "import_role"),
                             "tasks must be inline: " + str(i["task"].get("name")))
            self.assertTrue(i["task"].get("name"), "every task needs a name: " + blob(i["task"])[:80])

    def test_runs_on_the_data_group_only(self):
        for p in self.plays:
            hosts = str(p["hosts"])
            self.assertEqual(hosts.strip(), "data", "play hosts must be exactly the group `data` (db container host), got %r" % hosts)

    def test_no_literal_host_names_or_ips(self):  # LD-45: both profiles
        body = strip_comments(self.text)
        self.assertIsNone(HOSTNAME_RE.search(body), "host name hard-coded: %s" % HOSTNAME_RE.search(body))
        self.assertNotIn("10.79.", body, "wg address hard-coded")

    def _guard_chain(self):
        stat = [i for i in self.items if short(module_of(i["task"])) == "stat" and with_marker(i)]
        self.assertEqual(len(stat), 1, "exactly one `stat` task of %s required" % MARKER)
        reg = stat[0]["task"].get("register")
        self.assertTrue(reg, "the marker stat task must `register:`")
        guards = [i for i in self.items if short(module_of(i["task"])) in ("fail", "assert") and i["idx"] > stat[0]["idx"]]
        self.assertTrue(guards, "no fail/assert guard after the marker stat")
        return stat[0], reg, guards[0]

    def test_marker_guard_refuses_when_marker_exists(self):
        _, reg, guard = self._guard_chain()
        t = guard["task"]
        mod = short(module_of(t))
        self.assertFalse(t.get("ignore_errors"), "guard must not ignore errors")
        for exists, must_fire in ((True, True), (False, False)):
            c = ctx(**{reg: {"stat": {"exists": exists}}})
            if mod == "fail":
                fires = active(guard, c)
            else:
                that = t[mod]["that"]
                that = that if isinstance(that, list) else [that]
                fires = active(guard, c) and not all(ev(x, c) for x in that)
            self.assertEqual(fires, must_fire, "guard behaviour wrong for marker exists=%s (re-run refusal)" % exists)

    def test_guard_runs_before_every_psql_and_marker_write_after(self):
        stat, _, guard = self._guard_chain()
        ps = psql_items(self.items)
        self.assertTrue(ps, "no psql task")
        for p in ps:
            self.assertGreater(p["idx"], guard["idx"], "psql runs before the marker guard: " + p["task"]["name"])
        writes = [i for i in self.items if with_marker(i) and i is not stat and i["idx"] != guard["idx"]
                  and short(module_of(i["task"])) not in ("stat", "fail", "assert")]
        self.assertTrue(writes, "no task writes the marker %s" % MARKER)
        self.assertEqual(len(writes), 1, "exactly one marker write expected")
        w = writes[0]
        self.assertGreater(w["idx"], max(p["idx"] for p in ps), "marker is written before the last psql (a failed run would be marked done)")
        self.assertEqual(w["section"], "tasks", "marker must not be written in rescue/always")
        for need in ("_pw", "password", "secret"):
            self.assertNotIn(need, blob(w["task"]).lower(), "marker task must not carry secrets (%s)" % need)

    def test_psql_runs_in_db_container_as_provisioning_superuser(self):
        for i in psql_items(self.items):
            cmd = cmd_of(i["task"])
            self.assertRegex(cmd, r"\bexec\b", "psql must run inside the db container (docker [compose] exec): " + i["task"]["name"])
            self.assertRegex(cmd, r"\bdb\b", "the db container/service must be named")
            m = re.search(r"(?:-U|--username[ =])\s*[\"']?([\w{}. -]+?)[\"']?(?:\s|$)", cmd)
            self.assertTrue(m, "psql needs -U <provisioning superuser>")
            self.assertFalse(m.group(1).strip().startswith("lims_"), "bootstrap must not run as a lims_* role")

    def test_psql_flags_and_file_order(self):
        ps = psql_items(self.items)
        order = []
        for i in ps:
            cmd = cmd_of(i["task"]) + " " + blob(i["task"])
            self.assertRegex(cmd, r"-v\s+ON_ERROR_STOP=1", "ON_ERROR_STOP=1 required: " + i["task"]["name"])
            self.assertRegex(cmd, r"-v\s+dbname=[\"']?\{\{\s*app_db_name\s*\}\}", "-v dbname={{ app_db_name }} required: " + i["task"]["name"])
            for f in ("00_roles.sql", "01_database.sql"):
                if f in cmd:
                    order.append((i["idx"], cmd.index(f), f))
            if "01_database.sql" in cmd:
                self.assertRegex(cmd, r"(?:-d|--dbname[ =])\s*[\"']?\{\{\s*app_db_name\s*\}\}", "01_database.sql must run with -d {{ app_db_name }}")
        files = [f for _, _, f in sorted(order)]
        globbed = any(re.search(r"bootstrap/\*\.sql", cmd_of(i["task"]) + blob(i["task"])) and "sort" in blob(i["task"]) for i in ps)
        self.assertTrue(files == ["00_roles.sql", "01_database.sql"] or globbed,
                        "00_roles.sql must run before 01_database.sql (explicit, or a sorted db/bootstrap/*.sql glob); got %s" % files)

    def test_all_six_role_passwords_passed_from_the_secret_store(self):
        allcmd = " ".join(cmd_of(i["task"]) + " " + blob(i["task"]) for i in psql_items(self.items))
        for r in PW_ROLES:
            var = r + "_pw"
            self.assertRegex(allcmd, r"(?:-v\s+|\\\\set\s+)%s\b" % var, "psql variable %s not passed (00_roles.sql needs it)" % var)
            for m in re.finditer(r"-v\s+%s=([^\s]*)" % var, allcmd):
                v = m.group(1).strip("\"'\\")
                self.assertTrue(v.startswith("{{") or v.startswith("$"), "%s must come from a template/shell expansion, not a literal: %r" % (var, v))

    def test_secret_tasks_are_no_log_and_no_literal_secret(self):
        for i in self.items:
            b = blob(i["task"])
            if re.search(r"_pw\b|password|PGPASSWORD", b, re.I):
                self.assertIs(i["task"].get("no_log"), True, "task handles passwords but lacks no_log: true: " + i["task"]["name"])
        self.assertIsNone(re.search(r"PGPASSWORD=[^{$\s\"']", self.text), "literal PGPASSWORD")

    def test_psql_failures_stop_the_play(self):
        for i in psql_items(self.items):
            t = i["task"]
            self.assertFalse(t.get("ignore_errors"), "psql must not ignore errors")
            self.assertNotIn(str(t.get("failed_when")).lower(), ("false", "no", "0"), "failed_when must not mask failure")
            self.assertNotRegex(cmd_of(t), r"\|\|\s*(true|:)|;\s*true\b|set \+e", "exit code masked")
            self.assertIn(i["section"], ("tasks",), "psql in rescue/always could mark a failed bootstrap as done")

    def test_bootstrap_does_not_run_the_deploy_flow(self):
        for needle in ("db:migrate", "registry-sync"):
            self.assertNotIn(needle, self.text, "migrations/registry-sync belong to deploy.yml, not bootstrap")


# ====================================================================================================
class DeployFlowTest(unittest.TestCase):
    """AC-27.2: migrations (lims_migrator) -> registry-sync -> seeds, then API/worker start; any failure stops the pipeline."""

    @classmethod
    def setUpClass(cls):
        cls.plays = load(DEPLOY)
        cls.items = items_of(cls.plays)
        cls.text = DEPLOY.read_text(encoding="utf-8")
        cmdi = [i for i in cls.items if cmd_of(i["task"])]
        cls.mig = [i for i in cmdi if "db:migrate" in cmd_of(i["task"])]
        cls.reg = [i for i in cmdi if "worker:registry-sync" in cmd_of(i["task"])]
        cls.seed = [i for i in cmdi if i not in cls.mig + cls.reg and re.search(r"seed", cmd_of(i["task"]) + i["task"].get("name", ""), re.I)]
        cls.start = [i for i in cmdi if re.search(r"compose.*\bup\b", cmd_of(i["task"])) and re.search(r"\b(api|worker|web|portal)", cmd_of(i["task"]))]
        cls.steps = cls.mig + cls.reg + cls.seed

    def test_tasks_inline_named_no_literal_hosts(self):
        for i in self.items:
            self.assertNotIn(short(module_of(i["task"])), ("include_tasks", "import_tasks", "include_role", "import_role"),
                             "tasks must be inline: " + str(i["task"].get("name")))
            self.assertTrue(i["task"].get("name"), "every task needs a name")
        body = strip_comments(self.text)
        self.assertIsNone(HOSTNAME_RE.search(body), "host name hard-coded (LD-45): %s" % HOSTNAME_RE.search(body))
        self.assertNotIn("10.79.", body, "wg address hard-coded")

    def test_three_steps_exist_once_each_in_order(self):
        for name, grp in (("db:migrate", self.mig), ("worker:registry-sync", self.reg), ("seeds", self.seed)):
            self.assertTrue(grp, "no command task for %s" % name)
        self.assertLess(max(i["idx"] for i in self.mig), min(i["idx"] for i in self.reg), "registry-sync must come after ALL migrations")
        self.assertLess(max(i["idx"] for i in self.reg), min(i["idx"] for i in self.seed), "seeds must come after registry-sync")

    def test_steps_run_in_the_one_shot_migrate_container(self):
        for i in self.steps:
            cmd = cmd_of(i["task"])
            self.assertRegex(cmd, r"docker\s+compose\b.*\brun\b.*--rm\b.*\bmigrate\b", "must be `docker compose ... run --rm migrate ...`: " + i["task"]["name"])

    def test_steps_run_on_the_app_group_never_ops(self):
        for i in self.steps:
            self.assertEqual(str(i["play"]["hosts"]).strip(), "app", "DB flow play must target group `app` (source address admitted by pg_hba)")
            self.assertNotIn("delegate_to", i["task"], "no delegation: ops/localhost must never open the DB connection")
            for p in i["parents"]:
                self.assertNotIn("delegate_to", p)
            self.assertIs(i["task"].get("run_once"), True, "run_once: true (no concurrent migrators): " + i["task"]["name"])

    def test_direct_connection_as_lims_migrator(self):
        steps_blob = " ".join(blob(i["task"]) for i in self.steps) + " ".join(json.dumps(i["play"].get("vars", {})) for i in self.steps)
        self.assertIn("db_primary_wg_ip", steps_blob, "must connect directly to {{ db_primary_wg_ip }}")
        self.assertRegex(steps_blob, r"5432")
        self.assertNotRegex(self.text, r"6432|pgbouncer", "migrations must not go through PgBouncer (session locks, lock_timeout)")
        self.assertIn("lims_migrator", steps_blob, "steps must log in as lims_migrator")
        for bad in ("supabase_admin", "POSTGRES_PASSWORD", "lims_owner", "lims_api", "lims_worker"):
            self.assertNotIn(bad, self.text, "deploy.yml must not use %s for the DB flow" % bad)
        self.assertNotRegex(self.text, r"(?:-U|--username[ =])\s*postgres\b")

    def test_secrets_never_literal_and_no_log(self):
        for i in self.items:
            b = blob(i["task"])
            if re.search(r"password|PGPASSWORD|_pw\b", b, re.I):
                self.assertIs(i["task"].get("no_log"), True, "task handles passwords but lacks no_log: true: " + i["task"]["name"])
        self.assertIsNone(re.search(r"(?im)^\s*\w*password\w*\s*:\s*[\"']?[A-Za-z0-9+/=]{6,}[\"']?\s*$", strip_comments(self.text)),
                          "literal password value in deploy.yml")
        self.assertIsNone(re.search(r"PGPASSWORD=[^{$\s\"']", self.text), "literal PGPASSWORD")

    def test_play_stops_everywhere_on_first_failure(self):
        for i in self.steps:
            self.assertIs(i["play"].get("any_errors_fatal"), True, "the DB-flow play needs any_errors_fatal: true")

    def test_failure_stops_pipeline_no_masking(self):
        for i in self.items:
            t = i["task"]
            if i["section"] != "tasks" and "fail" not in blob(t):
                self.fail("rescue/always task may swallow a DB-flow failure: " + t["name"])
            for holder in (t,) + tuple(i["parents"]):
                self.assertFalse(holder.get("ignore_errors"), "ignore_errors on %s" % t["name"])
                self.assertNotIn(str(holder.get("failed_when")).lower(), ("false", "no", "0"), "failed_when masks failure on %s" % t["name"])
        for i in self.steps:
            t = i["task"]
            self.assertNotRegex(cmd_of(t), r"\|\|\s*(true|:|exit 0)|;\s*true\b|set \+e|\|\s*tee\b", "exit code masked: " + t["name"])
            self.assertFalse(t.get("async") and t.get("poll") in (0, "0"), "fire-and-forget step: " + t["name"])

    def test_app_start_only_after_all_db_steps(self):
        last = max(i["idx"] for i in self.steps)
        for s in self.start:
            self.assertGreater(s["idx"], last, "API/worker start before seeds finished: " + s["task"]["name"])

    def test_seeds_by_environment(self):
        for env in ("prod", "staging", "dev"):
            texts = [t for i in self.seed for t in rendered_cmds(i, ctx(env=env))]
            self.assertTrue(texts, "no seed command is active for env=%s" % env)
            joined = " ".join(texts)
            if env == "prod":
                for n in ("001", "002", "003"):
                    self.assertIn(n, joined, "prod must apply seed %s" % n)
                self.assertNotIn("010", joined, "prod must not apply tenant seeds (010+)")
                self.assertNotRegex(joined, r"--all\b|seeds/\*|\*\.sql", "prod seeds must be restricted to 001-003")
            else:
                self.assertTrue("010" in joined or re.search(r"--all\b|seeds/\*|\*\.sql", joined), "env=%s must apply ALL seeds" % env)

    def test_steps_are_not_env_gated_except_seeds_and_backup(self):
        for i in self.mig + self.reg:
            for env in ("prod", "staging", "dev"):
                self.assertTrue(rendered_cmds(i, ctx(env=env)), "migrate/registry-sync must run in env=%s" % env)

    def test_optional_prod_only_pre_backup(self):
        bk = [i for i in self.items if "pgbackrest" in cmd_of(i["task"]) and " backup" in cmd_of(i["task"])]
        for b in bk:
            cmd = cmd_of(b["task"])
            self.assertIn("--type=incr", cmd)
            self.assertIn("--repo=1", cmd)
            self.assertLess(b["idx"], min(i["idx"] for i in self.mig), "pre-deploy backup must precede migrations")
            self.assertTrue(rendered_cmds(b, ctx(env="prod")), "backup must run in prod")
            for env in ("staging", "dev"):
                self.assertFalse(rendered_cmds(b, ctx(env=env)), "backup is prod only (env=%s)" % env)

    def test_deploy_does_not_bootstrap(self):
        self.assertNotIn("00_roles.sql", self.text)
        self.assertNotIn("01_database.sql", self.text)
        self.assertNotIn(MARKER, self.text, "deploy.yml must not touch the bootstrap marker")


# ====================================================================================================
class PgHbaRejectsOpsTest(unittest.TestCase):
    """done_when: a connection attempt from the ops host is rejected by pg_hba (TRD s7.7: no entry for ops-1); the migrate
    container (app host wg IP) is admitted. In `lean`/dev the ops role shares the app host, so only foreign addresses are checked."""

    def _rules(self, profile):
        p = PROFILES[profile]
        c = {"app_db_name": "postgres", "groups": p["groups"], "hostvars": {h: {"wg_ip": ip} for h, ip in p["hosts"].items()},
             "docker_subnets": dict(t04.SUBNETS), "inventory_hostname": p["groups"]["data"][0], "wg_ip": p["hosts"][p["groups"]["data"][0]],
             "db_primary_wg_ip": p["hosts"][p["groups"]["data"][0]], "archive_timeout_s": 60}
        src = t04._find("pg_hba.conf*")
        self.assertIsNotNone(src, "missing infra/database/postgresql/pg_hba.conf.j2")
        out = JENV.from_string(src.read_text(encoding="utf-8")).render(**c)
        self.assertNotIn("UNDEF_", out)
        return t04.parse_hba(out), p

    def test_full_profile_ops_rejected_app_admitted(self):
        rules, p = self._rules("full")
        ops_ip, app_ip = p["hosts"]["ops-1"], p["hosts"]["app-1"]
        for user in ("lims_migrator", "lims_api", "supabase_admin", "postgres", "lims_monitor"):
            for db in ("postgres", "all-dbs-probe"):
                self.assertTrue(t04.denied(t04.decide(rules, "host", db, user, ops_ip)), "ops host must be rejected for %s/%s" % (db, user))
        self.assertEqual(t04.decide(rules, "host", "postgres", "lims_migrator", app_ip), "scram-sha-256",
                         "the migrate container (arrives from the app wg IP) must be admitted for lims_migrator")

    def test_lean_and_dev_only_the_shared_host_is_admitted(self):
        for prof, stranger in (("lean", "10.79.0.15"), ("dev", "10.79.0.99")):
            rules, p = self._rules(prof)
            shared = p["hosts"][p["groups"]["app"][0]]
            self.assertEqual(t04.decide(rules, "host", "postgres", "lims_migrator", shared), "scram-sha-256", prof)
            self.assertTrue(t04.denied(t04.decide(rules, "host", "postgres", "lims_migrator", stranger)), "%s: unknown wg address must be rejected" % prof)


# ====================================================================================================
class MigrateServiceTest(unittest.TestCase):
    """CONTRACT: `docker compose run --rm migrate` needs a `migrate` service (TRD s7.9: attached to db_net, one-shot)."""

    def test_migrate_service_defined_on_db_net_without_ports(self):
        found = []
        for f in sorted(COMPOSE.rglob("*.y*ml")) if COMPOSE.is_dir() else []:
            try:
                doc = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
            except yaml.YAMLError:
                continue
            svc = (doc.get("services") or {}).get("migrate") if isinstance(doc, dict) else None
            if isinstance(svc, dict):
                found.append((f, svc))
        self.assertTrue(found, "no `migrate` service under infra/compose (override.app.yml is the natural place)")
        _, svc = found[0]
        nets = svc.get("networks") or []
        self.assertIn("db_net", list(nets) if not isinstance(nets, dict) else list(nets.keys()), "migrate must attach to db_net")
        self.assertFalse(svc.get("ports"), "one-shot migrate must publish no ports")
        self.assertNotIn(svc.get("restart"), ("always", "unless-stopped"), "migrate is one-shot")


if __name__ == "__main__":
    unittest.main()
