"""T-06 tests: secrets schema + `secrets_render` role + secrets-not-default tool (AC-05.1/05.3/19.1/19.3/21.1).

Run: python -B -m unittest discover -s infra/tests/static -p "test_t06_*.py"   (stdlib + PyYAML, no ansible/sops/docker)

CONTRACTS the implementation must meet (tester-defined; mismatch = file a CR, do not edit the test):
 role infra/ansible/roles/secrets_render/{defaults/main.yml,tasks/*.yml}; defaults define
   secrets_render_secrets_dir=/run/lims/secrets  secrets_render_env_dir=/run/lims/env  secrets_render_mode="0400"
   secrets_render_placement: {<secret id>: {hosts: [inventory groups data|app|ops|dr], services: [...],
                              exposure: file|env, readonly: bool(optional)}}   (file -> <secrets_dir>/<service>/<id>,
                              env -> <env_dir>/<service>.env)
   secrets_render_fixed_env: non-secret hardened upstream env vars (AC-05.3).
 tasks: decrypt with `sops -d` delegated to localhost, no_log, stdout only (no --output/--in-place); assert tmpfs
   (the word `tmpfs` + /run/lims) BEFORE the first write; every write dest under /run/lims/{secrets,env}/ mode 0400
   + owner; one ops_audit task (who/what/when, never a value).
 Not provable here: real sops/age decrypt, real tmpfs mount, real file ownership, docker inspect (live: test_t06_live.py).
"""
import copy
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
INFRA = os.path.join(ROOT, "infra")
ROLE = os.path.join(INFRA, "ansible", "roles", "secrets_render")
SCHEMA = os.path.join(INFRA, "secrets", "schema", "%s.secrets.schema.yaml")
TOOL = os.path.join(INFRA, "tests", "internal", "secrets_not_default.py")
INSPECT_TOOL = os.path.join(INFRA, "tests", "internal", "docker_inspect_secrets.py")
UPSTREAM_COMPOSE = os.path.join(INFRA, "compose", "supabase", "upstream", "docker-compose.yml")
ENVS = ("dev", "staging", "prod")
UPSTREAM_IDS = ("POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY "
                "JWT_KEYS JWT_JWKS DASHBOARD_USERNAME DASHBOARD_PASSWORD SECRET_KEY_BASE REALTIME_DB_ENC_KEY "
                "VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN "
                "S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET MINIO_ROOT_PASSWORD POOLER_TENANT_ID "
                "SMTP_USER SMTP_PASS").split()
AC193_IDS = ("bff_key_staff_web bff_key_partner bff_key_portal valkey_lims_api_password reporting_otp_hmac_key "
             "renderer_inbound_token pdf_sandbox_inbound_token instruments_config_signing_key "
             "instruments_release_signing_key instruments_authenticode_cert payments_kek tenant_ops_contacts "
             "alert_contacts").split()
CORE = {"api-a", "api-b"}
WORKERS = {"worker-a", "worker-b"}
WRITE_MODS = {"copy", "template", "lineinfile", "blockinfile", "ansible.builtin.copy", "ansible.builtin.template",
              "ansible.builtin.lineinfile", "ansible.builtin.blockinfile"}


def _yaml(path):
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def _schema(env):
    return _yaml(SCHEMA % env)


def _need(path):
    if not os.path.exists(path):
        raise AssertionError("missing file: " + os.path.relpath(path, ROOT))
    return path


def _defaults():
    return _yaml(_need(os.path.join(ROLE, "defaults", "main.yml"))) or {}


def _tasks():
    files = sorted(glob.glob(os.path.join(ROLE, "tasks", "*.yml")))
    if not files:
        raise AssertionError("missing file: infra/ansible/roles/secrets_render/tasks/main.yml")
    out = []

    def walk(items):
        for t in items or []:
            for k in ("block", "rescue", "always"):
                if k in t:
                    walk(t[k])
            out.append(t)

    for f in files:
        walk(_yaml(f))
    return out


def _module(t):
    for k in t:
        if k in WRITE_MODS or k in ("assert", "command", "shell", "stat", "file", "ansible.builtin.assert",
                                    "ansible.builtin.command", "ansible.builtin.shell", "ansible.builtin.stat",
                                    "ansible.builtin.file", "ansible.builtin.include_tasks", "include_tasks"):
            return k.split(".")[-1]
    return None


def _txt(t):
    return json.dumps(t, sort_keys=True, default=str)


def _resolve(s, d):
    s = str(s)
    s = re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: str(d.get(m.group(1), m.group(0))), s)
    return re.sub(r"\{\{[^}]*\}\}", "X", s)


# ---------------------------------------------------------------- schema (AC-19.3, AC-19.1, AC-21.1)
class SchemaTest(unittest.TestCase):
    def test_ac193_ids_in_every_env_schema(self):
        for env in ENVS:
            ids = {s["id"] for s in _schema(env)["secrets"]}
            for i in AC193_IDS:
                self.assertIn(i, ids, "%s schema lacks %s" % (env, i))

    def test_same_id_set_all_envs(self):
        sets = [{s["id"] for s in _schema(e)["secrets"]} for e in ENVS]
        self.assertEqual(sets[0], sets[1])
        self.assertEqual(sets[0], sets[2])

    def test_trd_82_upstream_ids_all_present(self):
        ids = {s["id"] for s in _schema("dev")["secrets"]}
        self.assertFalse(set(UPSTREAM_IDS) - ids)

    def test_exposure_env_is_exactly_upstream_plus_valkey(self):
        want = set(UPSTREAM_IDS) | {"valkey_lims_api_password"}
        for env in ENVS:
            got = {s["id"] for s in _schema(env)["secrets"] if s.get("exposure") == "env"}
            self.assertEqual(got, want, env)

    def test_length_rules_declared(self):
        by = {s["id"]: s for s in _schema("dev")["secrets"]}
        for i, rule in (("JWT_SECRET", "32"), ("SECRET_KEY_BASE", "64"), ("REALTIME_DB_ENC_KEY", "16"),
                        ("VAULT_ENC_KEY", "32"), ("PG_META_CRYPTO_KEY", "32"), ("LOGFLARE_PRIVATE_ACCESS_TOKEN", "32")):
            self.assertIn(rule, str(by[i].get("length")), i)
        self.assertIn("exactly", by["REALTIME_DB_ENC_KEY"]["length"])
        self.assertIn("exactly", by["VAULT_ENC_KEY"]["length"])

    def test_no_value_in_schema(self):
        for env in ENVS:
            for s in _schema(env)["secrets"]:
                self.assertFalse({"value", "default"} & set(s), s["id"])

    def test_consumers_match_ac193(self):
        by = {s["id"]: s["consumers"] for s in _schema("prod")["secrets"]}
        self.assertEqual(set(by["bff_key_staff_web"]), CORE | {"web"})
        self.assertEqual(set(by["bff_key_partner"]), CORE | {"partner"})
        self.assertEqual(set(by["bff_key_portal"]), CORE | {"portal"})
        self.assertEqual(set(by["payments_kek"]), CORE | WORKERS)
        for i in ("instruments_release_signing_key", "instruments_authenticode_cert"):
            self.assertTrue(all("ops-1" in c for c in by[i]), i)


# ---------------------------------------------------------------- role: files, defaults, placement
class RoleDefaultsTest(unittest.TestCase):
    def test_files_exist(self):
        _need(os.path.join(ROLE, "defaults", "main.yml"))
        _need(os.path.join(ROLE, "tasks", "main.yml"))

    def test_paths_and_mode(self):
        d = _defaults()
        self.assertEqual(d.get("secrets_render_secrets_dir"), "/run/lims/secrets")
        self.assertEqual(d.get("secrets_render_env_dir"), "/run/lims/env")
        self.assertEqual(str(d.get("secrets_render_mode")), "0400")

    def test_placement_ids_subset_of_schema_and_exposure_agrees(self):
        pl = _defaults().get("secrets_render_placement")
        self.assertTrue(pl, "secrets_render_placement missing")
        by = {s["id"]: s for s in _schema("prod")["secrets"]}
        for i, e in pl.items():
            self.assertIn(i, by, "placement id not in schema: " + i)
            self.assertEqual(e.get("exposure", "file"), "env" if by[i].get("exposure") == "env" else "file", i)
            self.assertTrue(e.get("services") and e.get("hosts"), i)

    def test_every_exposure_env_id_rendered_to_env_file(self):
        pl = _defaults().get("secrets_render_placement") or {}
        for i in set(UPSTREAM_IDS) | {"valkey_lims_api_password"}:
            self.assertEqual((pl.get(i) or {}).get("exposure"), "env", i)

    def test_every_ac193_secret_has_a_placement_except_none(self):
        pl = _defaults().get("secrets_render_placement") or {}
        for i in AC193_IDS:
            self.assertIn(i, pl, i)

    def test_bff_keys_only_api_and_own_bff(self):
        pl = _defaults()["secrets_render_placement"]
        for i, own in (("bff_key_staff_web", "web"), ("bff_key_partner", "partner"), ("bff_key_portal", "portal")):
            self.assertEqual(set(pl[i]["services"]), CORE | {own}, i)

    def test_instrument_release_secrets_on_no_product_host(self):
        pl = _defaults()["secrets_render_placement"]
        for i in ("instruments_release_signing_key", "instruments_authenticode_cert"):
            self.assertEqual(pl[i]["hosts"], ["ops"], i)

    def test_payments_kek_readonly_api_and_workers_only(self):
        e = _defaults()["secrets_render_placement"]["payments_kek"]
        self.assertEqual(set(e["services"]), CORE | WORKERS)
        self.assertIs(e.get("readonly"), True)

    def test_placement_services_within_schema_consumers(self):
        pl = _defaults()["secrets_render_placement"]
        by = {s["id"]: s["consumers"] for s in _schema("prod")["secrets"]}
        for i in AC193_IDS:
            if i in pl and isinstance(by[i], list) and i not in ("valkey_lims_api_password",):
                names = set(pl[i]["services"])
                self.assertTrue(all(any(n == c or n in str(c) for c in by[i]) for n in names), i)

    def test_reporting_channel_prefix_placement(self):
        pp = _defaults().get("secrets_render_prefix_placement") or {}
        e = pp.get("reporting_channel_")
        self.assertTrue(e, "secrets_render_prefix_placement['reporting_channel_'] missing")
        self.assertEqual(e["hosts"], ["app"])
        self.assertEqual(set(e["services"]), WORKERS)
        main = _txt(_yaml(_need(os.path.join(ROLE, "tasks", "main.yml"))))
        self.assertIn("secrets_render_prefix_placement", main, "tasks must apply prefix placement")

    def test_unknown_host_groups_rejected(self):
        for i, e in (_defaults().get("secrets_render_placement") or {}).items():
            self.assertTrue(set(e["hosts"]) <= {"data", "app", "ops", "dr"}, i)

    def test_fixed_env_ac053(self):
        fe = _defaults().get("secrets_render_fixed_env") or {}
        want = {"DISABLE_SIGNUP": "true", "ENABLE_PHONE_SIGNUP": "false", "ENABLE_PHONE_AUTOCONFIRM": "false",
                "ENABLE_ANONYMOUS_USERS": "false", "ENABLE_EMAIL_AUTOCONFIRM": "false", "OPENAI_API_KEY": ""}
        self.assertEqual({k: str(v).lower() if v is not None else "" for k, v in fe.items() if k in want}, want)

    def test_fixed_env_names_map_to_gotrue_vars_in_upstream_compose(self):
        txt = open(_need(UPSTREAM_COMPOSE), encoding="utf-8").read()
        for var, gotrue in (("DISABLE_SIGNUP", "GOTRUE_DISABLE_SIGNUP"), ("ENABLE_PHONE_SIGNUP", "GOTRUE_EXTERNAL_PHONE_ENABLED"),
                            ("ENABLE_PHONE_AUTOCONFIRM", "GOTRUE_SMS_AUTOCONFIRM"),
                            ("ENABLE_ANONYMOUS_USERS", "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED"),
                            ("ENABLE_EMAIL_AUTOCONFIRM", "GOTRUE_MAILER_AUTOCONFIRM")):
            self.assertRegex(txt, r"%s:\s*\$\{%s\}" % (gotrue, var))


# ---------------------------------------------------------------- role: tasks (AC-19.1, 07-SEC)
class RoleTasksTest(unittest.TestCase):
    def setUp(self):
        self.d = _defaults()
        self.tasks = _tasks()

    def test_every_write_dest_under_run_lims_tmpfs_paths(self):
        n = 0
        for t in self.tasks:
            m = _module(t)
            if m in WRITE_MODS | {"file"}:
                args = t.get(m) or t.get("ansible.builtin." + m) or {}
                dest = args.get("dest") or args.get("path")
                self.assertTrue(dest, "write task without dest: " + str(t.get("name")))
                r = _resolve(dest, self.d)
                self.assertRegex(r, r"^/run/lims/(secrets|env)(/|$)", "%s -> %s" % (t.get("name"), r))
                n += 1
        self.assertGreater(n, 0, "role writes nothing")

    def test_secret_files_mode_0400_and_owner(self):
        for t in self.tasks:
            m = _module(t)
            if m in WRITE_MODS:
                args = t.get(m) or t.get("ansible.builtin." + m)
                self.assertIn(str(_resolve(args.get("mode"), self.d)), ("0400", "400"), t.get("name"))
                self.assertTrue(args.get("owner"), "owner (container UID) missing: %s" % t.get("name"))

    def test_no_secret_task_logs_values(self):
        for t in self.tasks:
            s = _txt(t)
            if _module(t) in WRITE_MODS or "sops" in s:
                self.assertIs(t.get("no_log"), True, "no_log missing: %s" % t.get("name"))

    def test_sops_decrypt_on_controller_stdout_only(self):
        sops = [t for t in self.tasks if re.search(r"\bsops\b", _txt(t)) and re.search(r"(-d\b|--decrypt)", _txt(t))]
        self.assertTrue(sops, "no sops decrypt task")
        for t in sops:
            self.assertTrue(t.get("delegate_to") == "localhost" or t.get("connection") == "local", t.get("name"))
            s = _txt(t)
            for bad in ("--output", "--in-place", " -i ", ">"):
                self.assertNotIn(bad, s.replace("\\u003e", ""), "decrypt must not write a file: " + bad)

    def test_tmpfs_asserted_before_first_write(self):
        idx_t = [i for i, t in enumerate(self.tasks) if "tmpfs" in _txt(t) and "/run/lims" in _txt(t)
                 or ("tmpfs" in _txt(t) and "secrets_render_secrets_dir" in _txt(t))]
        idx_w = [i for i, t in enumerate(self.tasks) if _module(t) in WRITE_MODS]
        self.assertTrue(idx_t, "no tmpfs assertion")
        self.assertLess(min(idx_t), min(idx_w))

    def test_ops_audit_line_without_value(self):
        a = [t for t in self.tasks if "ops_audit" in _txt(t)]
        self.assertTrue(a, "no ops_audit task")
        for t in a:
            s = _txt(t).lower()
            for bad in ("value", "content", "secret_text"):
                self.assertNotIn(bad, s, "audit task may leak value")

    def test_no_literal_key_material_in_role(self):
        for f in glob.glob(os.path.join(ROLE, "**", "*"), recursive=True):
            if os.path.isfile(f):
                t = open(f, encoding="utf-8", errors="ignore").read()
                self.assertNotIn("AGE-SECRET-" + "KEY-", t, f)
                self.assertNotIn("BEGIN " + "PRIVATE KEY", t, f)
                self.assertNotIn("ENC" + "[AES256_GCM", t, f)

    def test_no_persistent_destination_anywhere(self):
        for f in glob.glob(os.path.join(ROLE, "**", "*.y*ml"), recursive=True):
            for p in ("/etc/", "/var/", "/opt/", "/srv/", "/home/", "/root/", "/tmp/"):
                self.assertNotIn("dest: " + p, open(f, encoding="utf-8").read(), f)


# ---------------------------------------------------------------- tool: secrets_not_default.py
def _run(*args, stdin=None):
    p = subprocess.run([sys.executable, "-B", *args], capture_output=True, text=True, input=stdin, timeout=60)
    return p.returncode, p.stdout, p.stderr


def _gen(schema, tag="a"):
    """Valid synthetic values: random-looking, right lengths, distinct per tag."""
    import hashlib
    out = {}
    for s in schema["secrets"]:
        i = s["id"]
        if "<" in i:
            continue
        v = hashlib.sha256((tag + i).encode()).hexdigest() * 2  # 128 chars
        if i == "REALTIME_DB_ENC_KEY":
            v = v[:16]
        elif i == "VAULT_ENC_KEY":
            v = v[:32]
        out[i] = v
    return out


class ToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.schema = _schema("dev")
        self.example = self._w("env.example", "\n".join(
            ["# comment", "POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password",
             "JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long", 'SMTP_PASS="fake_mail_password"',
             "SMTP_USER=fake_mail_user", "VAULT_ENC_KEY=your-encryption-key-32-chars-min"]))

    def _w(self, name, text):
        p = os.path.join(self.tmp.name, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def _vals(self, d, name="v.yaml"):
        return self._w(name, yaml.safe_dump(d))

    def run_tool(self, values, others=(), env="dev"):
        a = ["--env", env, "--values", self._vals(values), "--env-example", self.example]
        for e, v in others:
            a += ["--other", "%s=%s" % (e, self._vals(v, e + ".yaml"))]
        return _run(TOOL, *a)

    def test_valid_set_passes(self):
        rc, out, err = self.run_tool(_gen(self.schema))
        self.assertEqual(rc, 0, out + err)

    def test_default_example_value_fails(self):
        v = _gen(self.schema)
        v["POSTGRES_PASSWORD"] = "your-super-secret-and-long-postgres-password"
        rc, out, _ = self.run_tool(v)
        self.assertEqual(rc, 1)
        self.assertIn("POSTGRES_PASSWORD", out)

    def test_quoted_example_value_fails(self):
        v = _gen(self.schema)
        v["SMTP_PASS"] = "fake_mail_password"
        self.assertEqual(self.run_tool(v)[0], 1)

    def test_length_rules(self):
        for i, bad in (("JWT_SECRET", "x" * 31), ("SECRET_KEY_BASE", "x" * 63), ("REALTIME_DB_ENC_KEY", "x" * 15),
                       ("REALTIME_DB_ENC_KEY", "x" * 17), ("VAULT_ENC_KEY", "x" * 31), ("VAULT_ENC_KEY", "x" * 33),
                       ("PG_META_CRYPTO_KEY", "x" * 31), ("LOGFLARE_PRIVATE_ACCESS_TOKEN", "x" * 31)):
            v = _gen(self.schema)
            v[i] = bad
            rc, out, _ = self.run_tool(v)
            self.assertEqual(rc, 1, i + " " + str(len(bad)))
            self.assertIn(i, out)

    def test_length_boundaries_ok(self):
        v = _gen(self.schema)
        v.update(JWT_SECRET="y" * 32, SECRET_KEY_BASE="y" * 64, REALTIME_DB_ENC_KEY="y" * 16, VAULT_ENC_KEY="y" * 32)
        self.assertEqual(self.run_tool(v)[0], 0)

    def test_missing_extra_and_empty(self):
        v = _gen(self.schema)
        del v["payments_kek"]
        self.assertIn("payments_kek", self.run_tool(v)[1])
        v = _gen(self.schema)
        v["not_in_schema"] = "z" * 40
        rc, out, _ = self.run_tool(v)
        self.assertEqual(rc, 1)
        self.assertIn("not_in_schema", out)
        v = _gen(self.schema)
        v["bff_key_portal"] = "  "
        self.assertIn("bff_key_portal", self.run_tool(v)[1])
        v["bff_key_portal"] = None
        self.assertEqual(self.run_tool(v)[0], 1)

    def test_reporting_channel_pattern_ids_allowed(self):
        v = _gen(self.schema)
        v["reporting_channel_sms_main"] = "q" * 40
        self.assertEqual(self.run_tool(v)[0], 0)

    def test_repo_cipher_passes_must_differ(self):
        v = _gen(self.schema)
        v["pgbackrest_repo2_cipher_pass"] = v["pgbackrest_repo1_cipher_pass"]
        self.assertIn("pgbackrest_repo2_cipher_pass", self.run_tool(v)[1])

    def test_cross_env_shared_value_fails_and_distinct_passes(self):
        dev, stg = _gen(self.schema, "a"), _gen(self.schema, "b")
        self.assertEqual(self.run_tool(dev, [("staging", stg)])[0], 0)
        stg["lims_api_password"] = dev["lims_api_password"]
        rc, out, _ = self.run_tool(dev, [("staging", stg)])
        self.assertEqual(rc, 1)
        self.assertIn("lims_api_password", out)
        self.assertIn("staging", out)

    def test_value_never_printed(self):
        v = _gen(self.schema)
        v["POSTGRES_PASSWORD"] = "your-super-secret-and-long-postgres-password"
        v["JWT_SECRET"] = "SHORTSECRETVALUE"
        rc, out, err = self.run_tool(v)
        self.assertEqual(rc, 1)
        for leak in ("your-super-secret", "SHORTSECRETVALUE"):
            self.assertNotIn(leak, out + err)

    def test_usage_errors_exit_2(self):
        ok = self._vals(_gen(self.schema))
        self.assertEqual(_run(TOOL, "--env", "dev", "--values", os.path.join(self.tmp.name, "nope.yaml"),
                              "--env-example", self.example)[0], 2)
        self.assertEqual(_run(TOOL, "--env", "prod", "--values", ok, "--env-example", self.example,
                              "--schema", SCHEMA % "dev")[0], 2)  # schema env != --env
        self.assertEqual(_run(TOOL, "--env", "dev", "--values", ok, "--env-example",
                              os.path.join(self.tmp.name, "none"))[0], 2)

    def test_stdin_values(self):
        rc, out, err = _run(TOOL, "--env", "dev", "--values", "-", "--env-example", self.example,
                            stdin=yaml.safe_dump(_gen(self.schema)))
        self.assertEqual(rc, 0, out + err)

    def test_default_example_path_is_pinned_upstream_file(self):
        src = open(TOOL, encoding="utf-8").read()
        self.assertIn("upstream", src)
        self.assertTrue(os.path.exists(os.path.join(INFRA, "compose", "supabase", "upstream", ".env.example")))


# ---------------------------------------------------------------- tool: docker_inspect_secrets.py
def _c(svc, env=(), mounts=(), cmd=()):
    return {"Name": "/x-" + svc, "Config": {"Env": list(env), "Cmd": list(cmd), "Labels": {"com.docker.compose.service": svc}},
            "Mounts": [{"Source": s, "RW": rw} for s, rw in mounts]}


class InspectToolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.sec = os.path.join(self.tmp.name, "secrets")
        os.makedirs(os.path.join(self.sec, "api-a"))
        with open(os.path.join(self.sec, "api-a", "lims_api_password"), "w") as f:
            f.write("S3cretFileValue-0123456789\n")
        with open(os.path.join(self.sec, "api-a", "JWT_SECRET"), "w") as f:
            f.write("EnvExposedJwtValue-0123456789\n")

    def run_tool(self, containers):
        ins = os.path.join(self.tmp.name, "i.json")
        json.dump(containers, open(ins, "w"))
        return _run(INSPECT_TOOL, "--inspect", ins, "--secrets-dir", self.sec, "--schema", SCHEMA % "dev")

    def test_clean_host_passes(self):
        rc, out, err = self.run_tool([_c("api-a", ["LIMS_CORE_DB_PASSWORD_FILE=/run/secrets/lims_api_password"],
                                         [("/run/lims/secrets/api-a/payments_kek", False)])])
        self.assertEqual(rc, 0, out + err)

    def test_file_secret_value_in_env_cmd_label_fails(self):
        for c in (_c("api-a", ["DB_PASSWORD=S3cretFileValue-0123456789"]),
                  _c("api-a", cmd=["run", "--pw=S3cretFileValue-0123456789"])):
            rc, out, _ = self.run_tool([c])
            self.assertEqual(rc, 1)
            self.assertIn("lims_api_password", out)
            self.assertNotIn("S3cretFileValue", out)

    def test_exposure_env_secret_in_env_is_allowed(self):
        self.assertEqual(self.run_tool([_c("auth", ["JWT_SECRET=EnvExposedJwtValue-0123456789"])])[0], 0)

    def test_payments_kek_readwrite_or_wrong_service_fails(self):
        self.assertEqual(self.run_tool([_c("api-a", mounts=[("/run/lims/secrets/api-a/payments_kek", True)])])[0], 1)
        self.assertEqual(self.run_tool([_c("web", mounts=[("/run/lims/secrets/web/payments_kek", False)])])[0], 1)
        self.assertEqual(self.run_tool([_c("worker-b", mounts=[("/run/lims/secrets/worker-b/payments_kek", False)])])[0], 0)

    def test_bff_key_only_api_and_own_bff(self):
        m = lambda s, i: [("/run/lims/secrets/%s/%s" % (s, i), False)]
        self.assertEqual(self.run_tool([_c("web", mounts=m("web", "bff_key_staff_web"))])[0], 0)
        self.assertEqual(self.run_tool([_c("web", mounts=m("web", "bff_key_portal"))])[0], 1)
        self.assertEqual(self.run_tool([_c("worker-a", mounts=m("worker-a", "bff_key_partner"))])[0], 1)

    def test_instrument_release_secrets_never_on_product_host(self):
        for i in ("instruments_release_signing_key", "instruments_authenticode_cert"):
            self.assertEqual(self.run_tool([_c("api-a", mounts=[("/run/lims/secrets/api-a/" + i, False)])])[0], 1)

    def test_bad_input_exit_2(self):
        bad = os.path.join(self.tmp.name, "bad.json")
        open(bad, "w").write("{not json")
        self.assertEqual(_run(INSPECT_TOOL, "--inspect", bad, "--secrets-dir", self.sec, "--schema", SCHEMA % "dev")[0], 2)


if __name__ == "__main__":
    unittest.main()
