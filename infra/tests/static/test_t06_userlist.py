"""T-06 / LD-67 tests: secrets_render renders the PgBouncer auth_file (settles CR-C1-T07). NEW tests only.

Run: python -B -m unittest discover -s infra/tests/static -p "test_t06_userlist.py"   (stdlib + PyYAML + jinja2; no ansible/sops/docker)

LD-67 (2026-11-08, C1 T-06): on hosts in group `data` (lean: prod-1) the role renders
  {{ secrets_render_secrets_dir }}/pgbouncer/userlist.txt   mode 0400, owner = pgbouncer container UID (in secrets_render_uids),
  content = ONE line  "pgbouncer" "<POSTGRES_PASSWORD plaintext>"   derived from the existing POSTGRES_PASSWORD id
  (no new secret id, no new rotation); rotating POSTGRES_PASSWORD re-renders the file and reloads pgbouncer;
  tmpfs only, never committed, content never in logs. Dummy password only; no real credential is ever used here.
CONTRACTS (tester-defined; mismatch = file a CR, do not edit the test):
  - one write task (copy/template) with dest `<secrets_dir>/pgbouncer/userlist.txt`, mode 0400, owner referencing
    secrets_render_uids['pgbouncer'], no_log true, guarded by a `when` naming group `data`;
  - defaults secrets_render_uids has a positive integer for key `pgbouncer`;
  - that task `notify`s a handler (handlers/main.yml) or is followed by a task that reloads pgbouncer (rotation).
Live half: infra/tests/integration/test_t07_live.py class LiveRenderedUserlist (LIMS_T07_LIVE=1).
"""
import glob
import json
import os
import re
import unittest

import jinja2
import yaml

import test_t06_secrets as base  # reuse helpers; existing tests there stay unchanged

ROLE = base.ROLE
DUMMY = "dummy-LD67-not-a-real-pw"
DEST = "/run/lims/secrets/pgbouncer/userlist.txt"


def _userlist_task():
    hits = []
    for t in base._tasks():
        m = base._module(t)
        if m in base.WRITE_MODS:
            args = t.get(m) or t.get("ansible.builtin." + m) or {}
            dest = args.get("dest") or ""
            if base._resolve(dest, base._defaults()).endswith("/pgbouncer/userlist.txt") or "userlist.txt" in str(dest):
                hits.append((t, m, args))
    if len(hits) != 1:
        raise AssertionError("expected exactly 1 task writing pgbouncer/userlist.txt in secrets_render, found %d" % len(hits))
    return hits[0]


def _handlers():
    out = []
    for f in glob.glob(os.path.join(ROLE, "handlers", "*.y*ml")):
        out += base._yaml(f) or []
    return out


def _render(pw):
    """Render the userlist content the way ansible would, with a dummy password."""
    t, m, args = _userlist_task()
    d = base._defaults()
    ctx = dict(d)
    ctx.update(secrets_render_values={"POSTGRES_PASSWORD": pw}, item="pgbouncer", env="dev")
    ctx["secrets_render_here"] = {"POSTGRES_PASSWORD": d["secrets_render_placement"]["POSTGRES_PASSWORD"]}
    ctx.update(t.get("vars") or {})
    jenv = jinja2.Environment(undefined=jinja2.Undefined, keep_trailing_newline=True)
    jenv.filters.update(to_json=json.dumps, b64decode=lambda s: s,
                       dirname=os.path.dirname, basename=os.path.basename)
    if "content" in args:
        src = str(args["content"])
    else:
        name = args["src"]
        path = os.path.join(ROLE, "templates", os.path.basename(name))
        base._need(path)
        src = open(path, encoding="utf-8").read()
    # vars may themselves be templates
    for k, v in list(ctx.items()):
        if isinstance(v, str) and "{{" in v and k != "secrets_render_here":
            ctx[k] = jenv.from_string(v).render(**ctx)
    return jenv.from_string(src).render(**ctx)


class UserlistTaskTest(unittest.TestCase):
    def test_one_write_task_dest_mode_owner_nolog(self):
        t, m, args = _userlist_task()
        d = base._defaults()
        self.assertEqual(base._resolve(args["dest"], d), DEST)
        self.assertIn(str(base._resolve(args.get("mode"), d)), ("0400", "400"))
        self.assertIn("secrets_render_uids", str(args.get("owner")), "owner must be the pgbouncer container UID")
        self.assertIn("pgbouncer", str(args.get("owner")) + str(args.get("group")), "owner/group must key on pgbouncer")
        self.assertIs(t.get("no_log"), True, "plaintext password: no_log required")

    def test_pgbouncer_uid_registered(self):
        uid = (base._defaults().get("secrets_render_uids") or {}).get("pgbouncer")
        self.assertIsInstance(uid, int, "secrets_render_uids['pgbouncer'] must be the container UID (int)")
        self.assertGreater(uid, 0, "never root")

    def test_only_on_data_hosts(self):
        t, _, _ = _userlist_task()
        w = str(t.get("when"))
        self.assertRegex(w, r"['\"]data['\"]\s+in\s+group_names|group_names\s*\|\s*intersect\(\s*\[\s*['\"]data['\"]", w)
        self.assertNotRegex(w, r"['\"](app|ops|dr)['\"]\s+in\s+group_names", "must not widen beyond data")

    def test_pgbouncer_dir_exists_before_write(self):
        tasks = base._tasks()
        ut_name = _userlist_task()[0].get("name")
        idx_w = next(i for i, t in enumerate(tasks) if t.get("name") == ut_name)
        dirs = [i for i, t in enumerate(tasks[:idx_w]) if base._module(t) == "file" and "pgbouncer" in base._txt(t)]
        general = [i for i, t in enumerate(tasks[:idx_w]) if base._module(t) == "file" and "secrets_render_files" in base._txt(t)]
        self.assertTrue(dirs or general, "no task creates <secrets_dir>/pgbouncer before the write")
        if dirs and not general:
            args = tasks[dirs[0]].get("file") or tasks[dirs[0]].get("ansible.builtin.file")
            self.assertEqual(str(args.get("state")), "directory")
            self.assertIn(str(args.get("mode")), ("0711", "0711 ", "0755", "0555", "0700", "0500"))

    def test_no_new_secret_id_or_placement(self):
        d = base._defaults()
        for k in list(d["secrets_render_placement"]) + list(d.get("secrets_render_prefix_placement") or {}):
            self.assertNotRegex(k.lower(), r"userlist|pgbouncer", "LD-67: derived from POSTGRES_PASSWORD, no new id: " + k)
        for env in base.ENVS:
            ids = [s["id"] for s in base._schema(env)["secrets"]]
            self.assertFalse([i for i in ids if re.search(r"userlist|pgbouncer", i.lower())], env)

    def test_postgres_password_still_env_exposed_on_data_and_app(self):
        e = base._defaults()["secrets_render_placement"]["POSTGRES_PASSWORD"]
        self.assertEqual(e.get("exposure"), "env")
        self.assertEqual(set(e["hosts"]), {"data", "app"})

    def test_rotation_rerenders_and_reloads_pgbouncer(self):
        t, _, _ = _userlist_task()
        notify = t.get("notify")
        notify = [notify] if isinstance(notify, str) else (notify or [])
        reload_tasks = [h for h in _handlers() + base._tasks()
                        if re.search(r"reload|SIGHUP|HUP|RELOAD", base._txt(h)) and "pgbouncer" in base._txt(h).lower()
                        and h is not t]
        self.assertTrue(reload_tasks, "no task/handler reloads pgbouncer on rotation")
        if not notify:  # inline reload task instead of a handler: must come after the write
            tasks = base._tasks()
            self.assertTrue(any(tasks.index(r) > tasks.index(t) for r in reload_tasks if r in tasks),
                            "reload must come after the userlist write")
        else:
            names = {h.get("name") for h in _handlers()} | {n for h in _handlers() for n in h.get("listen", [])
                                                           if isinstance(h.get("listen"), list)}
            self.assertTrue(set(notify) & names, "notify %s matches no handler" % notify)

    def test_reload_does_not_log_or_embed_password(self):
        for h in _handlers() + base._tasks():
            s = base._txt(h)
            if "pgbouncer" in s.lower() and re.search(r"reload|HUP", s, re.I) and "userlist" not in s.lower():
                self.assertNotIn("secrets_render_values", s)
                self.assertNotIn("POSTGRES_PASSWORD", s)


class UserlistContentTest(unittest.TestCase):
    def test_exactly_one_line_two_quoted_fields(self):
        out = _render(DUMMY)
        self.assertEqual(out, '"pgbouncer" "%s"\n' % DUMMY, repr(out))
        self.assertEqual(len(out.splitlines()), 1)

    def test_derives_from_postgres_password_only(self):
        out = _render("Zz9-Other_pw.1")
        self.assertIn('"Zz9-Other_pw.1"', out)

    def test_user_field_is_literal_pgbouncer(self):
        self.assertTrue(_render(DUMMY).startswith('"pgbouncer" "'))

    def test_embedded_double_quote_is_escaped_or_rejected(self):
        # Adversarial: a '"' in the password would corrupt the file (auth_file escapes " as ""). Either the template
        # doubles it, or the role refuses such a password before rendering (assert mentioning POSTGRES_PASSWORD).
        out = _render('a"b')
        if out == '"pgbouncer" "a""b"\n':
            return
        guards = [t for t in base._tasks() if base._module(t) == "assert" and "POSTGRES_PASSWORD" in base._txt(t)
                  and '"' in base._txt(t).replace('\\"', '"')]
        self.assertTrue(guards, "password with '\"' neither escaped nor rejected; got " + repr(out))

    def test_no_literal_password_or_secret_in_template_sources(self):
        t, _, args = _userlist_task()
        src = str(args.get("content", "")) + (open(os.path.join(ROLE, "templates", os.path.basename(args["src"])),
                                                    encoding="utf-8").read() if "src" in args else "")
        self.assertIn("POSTGRES_PASSWORD", src)
        self.assertNotRegex(src, r'"pgbouncer"\s+"[A-Za-z0-9+/=_.-]{8,}"', "literal credential in source")

    def test_no_debug_or_log_of_userlist_content(self):
        ut_name = _userlist_task()[0].get("name")
        for t in base._tasks():
            s = base._txt(t)
            if "userlist" in s and t.get("name") != ut_name:
                self.assertNotIn("debug", [k.split(".")[-1] for k in t], "debug of userlist content")


if __name__ == "__main__":
    unittest.main()
