"""T-34 tests (tester role): C7 bridge-agent release infrastructure (CR-C7-012).

Plan row T-34: ops-1 release service holding the release signing key + the client's Authenticode certificate,
`infra/ci/agent-release.sh`, signed-zip copy to app-1, `instruments.g_agent_releases` seed via the `migrate` container,
read-only `LIMS_INSTRUMENTS_RELEASES_DIR` mount on api-a/b, config-signing key on api/worker, Authenticode tool pinned and
registered in THIRD-PARTY-OPS.md. Tests: "release dry run; render-target assertion". ACs: AC-31.1, AC-31.2, AC-19.3.
Spec: 02-TRD s7.11, s8.2 (secret table), s7.4 (env table); C7 02-TRD s5.11 (artefact, signature over the raw SHA-256 bytes,
`authenticode_publisher` = certificate subject CN), C7 05-SCHEMA g_agent_releases; 07-SECURITY A9.
LD-45: lean = ops-1 and app-1 are the same host, so "keys never on app-1" is proven by the render-target table + compose
(no container can see the keys) in every profile, and by disjoint host groups in every `full` inventory. No host name here.

CONTRACTS where the spec is silent (writer meets them or files a dispute; nothing is a silent design change):
 * `infra/ci/agent-release.sh [--dry-run] <version>`; version must match ^[0-9]+\\.[0-9]+\\.[0-9]+$ (the DB CHECK; no newline,
   no `-rc1`, no path part). Env overrides (defaults in the script): LIMS_AGENT_RELEASE_ARTIFACT (input zip, default
   `bridge-agent-<version>-windows-amd64.zip` fetched per TRD), LIMS_AGENT_RELEASE_OUT (default `/srv/lims/agent-releases`),
   LIMS_AGENT_RELEASE_SECRETS_DIR (default `/run/lims/secrets/release`, files named by secret id).
 * `--dry-run`: reads NO secret, writes NOTHING to OUT, needs no docker/network, exits 0 and prints the plan (authenticode,
   ed25519, copy into agent-releases, g_agent_releases seed, migrate) in that order. Missing artefact -> non-zero.
 * Real run: fails closed BEFORE writing anything when a secret file is missing, naming the missing secret id; never echoes
   secret content; every read of the key and the certificate is noted through ci/ops-note.sh (ops_audit; ids only).
 * Seed is an INSERT into instruments.g_agent_releases (never DO UPDATE: a published version is immutable), applied as
   lims_migrator through the one-shot `migrate` container - in agent-release.sh or in the deploy.yml step.
 * Role `agent_release`: runs on group `ops` only; defaults pin the Authenticode tool (`*authenticode*version*`,
   `*authenticode*sha256*` 64 hex); the same version string is in the THIRD-PARTY-OPS.md row with a recorded licence.
   Unit `lims-agent-release.service` (templates/): oneshot, ExecStart agent-release.sh, NoNewPrivileges + PrivateTmp.
 * deploy.yml: a step guarded by `when:` on a release manifest/agent-release variable, after the seed step, executed on ops.
Stdlib + PyYAML + Jinja2 + bash (Git Bash on Windows). Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t34_*.py" -v
"""
import glob
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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_t14_runtime as t14  # noqa: E402  (helpers only: compose(), svc(), volumes_of(), env_of(), API, WORKERS, ALL)

ROOT = t14.ROOT
INFRA = ROOT / "infra"
SCRIPT = INFRA / "ci" / "agent-release.sh"
ROLE = INFRA / "ansible" / "roles" / "agent_release"
DEPLOY = INFRA / "ansible" / "playbooks" / "deploy.yml"
SITE = INFRA / "ansible" / "playbooks" / "site.yml"
THIRD = INFRA / "THIRD-PARTY-OPS.md"
PLACEMENT = INFRA / "ansible" / "roles" / "secrets_render" / "defaults" / "main.yml"
SCHEMAS = INFRA / "secrets" / "schema"
INVENTORIES = INFRA / "ansible" / "inventories"

MOUNT_SRC = "/srv/lims/agent-releases"
MOUNT_DST = "/run/lims/agent-releases"
KEY, CERT = "instruments_release_signing_key", "instruments_authenticode_cert"
CFG_KEY = "instruments_config_signing_key"
BASH = next((p for p in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")) if p and os.path.exists(p)), None)


def need(p):
    if not Path(p).exists():
        raise AssertionError("missing file: %s" % Path(p).relative_to(ROOT).as_posix())
    return Path(p)


def txt(p):
    return need(p).read_text(encoding="utf-8")


def code(p):
    """File text without full-line comments."""
    return "\n".join(l for l in txt(p).splitlines() if not l.lstrip().startswith("#"))


def ylo(p):
    return yaml.load(txt(p), Loader=t14._Loader)


def role_text():
    files = [f for f in ROLE.rglob("*") if f.is_file()]
    if not files:
        raise AssertionError("missing role infra/ansible/roles/agent_release")
    return "\n".join(f.read_text(encoding="utf-8") for f in sorted(files))


def release_logic():
    """Script + role files + deploy.yml: where the seed / migrate step may legitimately live."""
    return code(SCRIPT) + "\n" + role_text() + "\n" + code(DEPLOY)


# ------------------------------------------------------------------------------------------------ script (static)
class ScriptStaticTest(unittest.TestCase):
    def test_not_the_stub(self):
        t = txt(SCRIPT)
        self.assertNotIn("not implemented", t)
        self.assertGreater(len(code(SCRIPT).splitlines()), 25)

    def test_bash_syntax(self):
        self.assertTrue(BASH, "bash not found")
        r = subprocess.run([BASH, "-n", SCRIPT.as_posix()], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_strict_mode_and_umask_and_tmp(self):
        c = code(SCRIPT)
        self.assertRegex(c, r"set -euo pipefail")
        self.assertRegex(c, r"umask 0[07]7")
        self.assertIn("mktemp -d", c)
        self.assertRegex(c, r"trap .*(rm|shred)", "work dir (holds signed artefacts) must be removed on exit")

    def test_no_xtrace_no_eval_no_pipe_to_shell(self):
        c = code(SCRIPT)
        self.assertNotRegex(c, r"set\s+-[a-z]*x|set\s+-o\s+xtrace|bash\s+-x|\bPS4=")
        self.assertNotRegex(c, r"\beval\b")
        self.assertNotRegex(c, r"(curl|wget)[^\n|]*\|\s*(ba)?sh")

    def test_version_validated_before_use(self):
        c = code(SCRIPT)
        self.assertRegex(c, r"\^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$", "version regex of g_agent_releases__version__ck, anchored")

    def test_secret_ids_and_default_dir(self):
        c = code(SCRIPT)
        for needle in (KEY, CERT, "/run/lims/secrets/release", MOUNT_SRC):
            self.assertIn(needle, c)

    def test_signing_steps_present(self):
        c = code(SCRIPT)
        low = c.lower()
        self.assertIn("bridge-agent-", c)
        self.assertIn("windows-amd64.zip", c)
        self.assertRegex(low, r"authenticode")
        self.assertRegex(low, r"ed25519")
        self.assertIn("sha256", low)
        self.assertRegex(c, r"base64", "Ed25519 signature is stored base64url (C7 05-SCHEMA)")
        self.assertIn("authenticode_publisher", c)

    def test_keys_never_leave_ops_host(self):
        """No scp/rsync/ssh/docker cp line may mention a secret id or the secrets dir (only the signed zip travels)."""
        for line in code(SCRIPT).splitlines():
            if re.search(r"\b(scp|rsync|ssh|sftp|nc|curl|docker\s+(cp|run|compose))\b", line):
                self.assertNotRegex(line, r"instruments_(release_signing_key|authenticode_cert)|SECRETS_DIR|/secrets/",
                                    "secret leaves the host: " + line.strip())

    def test_ops_audit_lines_for_key_and_cert_reads(self):
        c = code(SCRIPT)
        self.assertIn("ops-note.sh", c)
        note_lines = [l for l in c.splitlines() if "ops-note" in l or "ops_note" in l]
        self.assertTrue(note_lines)
        joined = c
        # ids (never content) are recorded: both ids appear near an ops-note call
        for sid in (KEY, CERT):
            idx = [m.start() for m in re.finditer(re.escape(sid), joined)]
            near = [i for i in idx if re.search(r"ops[-_]note", joined[max(0, i - 400):i + 400])]
            self.assertTrue(near, "ops_audit note for %s missing" % sid)

    def test_seed_is_insert_never_update(self):
        t = release_logic()
        self.assertRegex(t, r"INSERT\s+INTO\s+instruments\.g_agent_releases", "seed row")
        for col in ("version", "channel", "package_file_name", "package_sha256", "package_size", "signature", "key_id",
                    "authenticode_publisher", "released_at"):
            self.assertIn(col, t, "seed column " + col)
        self.assertNotRegex(t, r"(?i)ON\s+CONFLICT[^;]*DO\s+UPDATE", "a published version is immutable")
        self.assertNotRegex(t, r"(?i)UPDATE\s+instruments\.g_agent_releases|DELETE\s+FROM\s+instruments\.g_agent_releases")

    def test_seed_applied_as_migrator_through_migrate_container(self):
        t = release_logic()
        self.assertRegex(t, r"docker compose[^\n]*(\n[^\n]*){0,6}\bmigrate\b", "one-shot `migrate` container (02-TRD s7.9)")
        self.assertIn("lims_migrator", t)
        self.assertNotRegex(t, r"lims_owner\s*(password|PASSWORD)|PGPASSWORD=\S{4,}", "no credential in argv/text")

    def test_does_not_overwrite_published_zip(self):
        c = code(SCRIPT)
        self.assertRegex(c, r"(-e|-f|--ignore-existing|set -o noclobber|exists|already)", "refuse to replace an existing release file")


# ------------------------------------------------------------------------------------------------ script (executed)
def _fake_zip(path):
    import zipfile
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("agent.exe", b"MZ-test-agent")
        z.writestr("manifest.json", json.dumps({"version": "1.2.3"}))


@unittest.skipUnless(BASH, "bash not found")
class ScriptRunTest(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp(prefix="t34-"))
        self.addCleanup(shutil.rmtree, self.td, ignore_errors=True)
        self.out = self.td / "out"
        self.out.mkdir()
        self.sec = self.td / "secrets"
        self.zip = self.td / "bridge-agent-1.2.3-windows-amd64.zip"
        _fake_zip(self.zip)

    def run_sh(self, *args, secrets=True, artifact=True):
        env = dict(os.environ)
        env.update(LIMS_AGENT_RELEASE_OUT=self.out.as_posix(),
                   LIMS_AGENT_RELEASE_SECRETS_DIR=(self.sec if secrets else self.td / "no-such-dir").as_posix())
        if artifact:
            env["LIMS_AGENT_RELEASE_ARTIFACT"] = self.zip.as_posix()
        else:
            env["LIMS_AGENT_RELEASE_ARTIFACT"] = (self.td / "missing.zip").as_posix()
        return subprocess.run([BASH, SCRIPT.as_posix(), *args], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)

    def out_files(self):
        return [p for p in self.out.rglob("*")]

    def test_dry_run_plan_in_order_no_secrets_no_writes(self):  # "release dry run"
        r = self.run_sh("--dry-run", "1.2.3", secrets=False)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        low = r.stdout.lower()
        pos = [low.find(k) for k in ("authenticode", "ed25519", "agent-releases", "g_agent_releases", "migrate")]
        self.assertNotIn(-1, pos, r.stdout)
        self.assertEqual(pos, sorted(pos), "plan order: sign, sign, copy, seed, migrate\n" + r.stdout)
        self.assertIn("bridge-agent-1.2.3-windows-amd64.zip", r.stdout)
        self.assertEqual(self.out_files(), [], "dry run wrote to OUT")

    def test_dry_run_does_not_read_secrets(self):
        self.sec.mkdir()
        for sid in (KEY, CERT):
            (self.sec / sid).write_text("SENTINEL-SECRET-%s-MATERIAL" % sid)
        r = self.run_sh("--dry-run", "1.2.3")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("SENTINEL-SECRET", r.stdout + r.stderr)
        self.assertNotIn('"stream":"ops_audit"', r.stdout.replace(" ", ""), "dry run read nothing, so no read is audited")

    def test_dry_run_missing_artifact_fails(self):
        r = self.run_sh("--dry-run", "1.2.3", artifact=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("not implemented", r.stderr)

    def test_bad_versions_rejected(self):
        for v in ("1.2", "1.2.3.4", "1.2.3-rc1", "v1.2.3", "../../etc/passwd", "1.2.3; touch x", "1.2.3\n", "", "1.2.x", "1.2.3/../4"):
            r = self.run_sh("--dry-run", v)
            self.assertNotEqual(r.returncode, 0, repr(v))
            self.assertNotIn("not implemented", r.stderr, repr(v))
            self.assertRegex((r.stderr + r.stdout).lower(), r"version", repr(v))
            self.assertEqual(self.out_files(), [], repr(v))
            self.assertFalse((ROOT / "x").exists() and v.startswith("1.2.3;"), "command injection")

    def test_no_args_is_usage_error(self):
        r = self.run_sh()
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex((r.stderr + r.stdout).lower(), r"usage|version")

    def test_real_run_fails_closed_when_secrets_missing(self):
        r = self.run_sh("1.2.3", secrets=False)
        self.assertNotEqual(r.returncode, 0)
        err = r.stderr + r.stdout
        self.assertTrue(KEY in err or CERT in err, "must name the missing secret id: " + err)
        self.assertEqual(self.out_files(), [], "nothing may be written before the secrets are present")

    def test_real_run_missing_cert_does_not_leak_key(self):
        self.sec.mkdir()
        (self.sec / KEY).write_text("SENTINEL-SECRET-KEY-MATERIAL")
        r = self.run_sh("1.2.3")
        self.assertNotEqual(r.returncode, 0)
        err = r.stderr + r.stdout
        self.assertIn(CERT, err)
        self.assertNotIn("SENTINEL-SECRET", err)
        self.assertEqual(self.out_files(), [])


# ------------------------------------------------------------------------------------------------ role / unit / site
class RoleTest(unittest.TestCase):
    def test_role_layout(self):
        need(ROLE / "tasks" / "main.yml")
        need(ROLE / "defaults" / "main.yml")

    def test_ops_only(self):
        plays = ylo(SITE)
        hits = [p for p in plays if "agent_release" in json.dumps(p.get("roles", []))]
        self.assertEqual(len(hits), 1, "site.yml must apply role agent_release exactly once")
        self.assertEqual(hits[0]["hosts"], "ops", "release service runs on ops only (02-TRD s7.11)")
        names = [json.dumps(p.get("roles", [])) for p in plays]
        i = next(n for n, s in enumerate(names) if "agent_release" in s)
        j = next((n for n, s in enumerate(names) if "registry" in s), None)
        self.assertIsNotNone(j, "registry play missing")
        self.assertLess(j, i, "registry must come before agent_release (the CI artefact comes from it)")

    def test_role_never_touches_app_group(self):
        t = role_text()
        self.assertNotRegex(t, r"groups\[['\"]app['\"]\]|hosts:\s*app\b")
        self.assertNotRegex(t, r"delegate_to:\s*[^\n]*app")

    def test_tool_pinned_in_defaults(self):
        d = ylo(ROLE / "defaults" / "main.yml") or {}
        ver = [k for k in d if re.search(r"authenticode.*version|version.*authenticode", k)]
        sha = [k for k in d if re.search(r"authenticode.*sha256|sha256.*authenticode", k)]
        self.assertTrue(ver, "defaults: <...authenticode...version> pin missing")
        self.assertTrue(sha, "defaults: <...authenticode...sha256> pin missing")
        v = str(d[ver[0]])
        self.assertRegex(v, r"\d", "version pin has a number")
        self.assertNotRegex(v.lower(), r"latest|^$|tbd|pins|to be recorded")
        self.assertRegex(str(d[sha[0]]), r"^[0-9a-f]{64}$")

    def test_tool_download_verified(self):
        t = role_text()
        self.assertRegex(t, r"checksum:|sha256sum|get_url", "tool archive must be checksum-verified")
        self.assertNotRegex(t, r"state:\s*latest")
        self.assertNotRegex(t, r"(curl|wget)[^\n|]*\|\s*(ba)?sh")

    def test_unit_template(self):
        units = glob.glob(str(ROLE / "templates" / "lims-agent-release.service*"))
        self.assertTrue(units, "templates/lims-agent-release.service(.j2) missing (02-TRD s7.11)")
        u = Path(units[0]).read_text(encoding="utf-8")
        self.assertRegex(u, r"Type=oneshot")
        self.assertRegex(u, r"ExecStart=[^\n]*agent-release\.sh")
        self.assertRegex(u, r"NoNewPrivileges=(yes|true)")
        self.assertRegex(u, r"PrivateTmp=(yes|true)")
        self.assertNotRegex(u, r"Restart=(always|on-failure)", "a release is one run, not a daemon")

    def test_role_installs_script_and_unit_on_ops_only_idempotently(self):
        t = txt(ROLE / "tasks" / "main.yml")
        self.assertIn("agent-release.sh", t)
        self.assertRegex(t, r"lims-agent-release\.service")
        self.assertRegex(t, r"daemon[_-]reload|daemon_reload")


# ------------------------------------------------------------------------------------------------ THIRD-PARTY-OPS
class ThirdPartyTest(unittest.TestCase):
    def row(self):
        for l in txt(THIRD).splitlines():
            if l.startswith("| Authenticode signing tool"):
                return [c.strip() for c in l.strip().strip("|").split("|")]
        raise AssertionError("THIRD-PARTY-OPS.md: Authenticode signing tool row missing")

    def test_row_is_recorded_not_placeholder(self):
        cells = self.row()
        self.assertGreaterEqual(len(cells), 5)
        name, ver, lic, host, listener = cells[:5]
        self.assertNotRegex(ver.lower(), r"pins|to be recorded|tbd|unverified")
        self.assertRegex(ver, r"\d")
        self.assertNotRegex(lic.lower(), r"to be recorded|tbd|unverified|^$")
        self.assertIn("ops-1", host)
        self.assertRegex(host.lower(), r"release service only|only")
        self.assertRegex(listener.lower(), r"no listener")

    def test_version_matches_role_pin(self):
        d = ylo(ROLE / "defaults" / "main.yml") or {}
        k = next((k for k in d if re.search(r"authenticode.*version|version.*authenticode", k)), None)
        self.assertIsNotNone(k)
        self.assertIn(str(d[k]).lstrip("v"), self.row()[1], "THIRD-PARTY-OPS version must equal the role pin")


# ------------------------------------------------------------------------------------------------ compose (AC-31.1)
class ComposeTest(unittest.TestCase):
    def test_api_mounts_releases_read_only(self):  # AC-31.1
        for n in t14.API:
            s = t14.svc(n)
            self.assertIn((MOUNT_SRC, MOUNT_DST, True), t14.volumes_of(s), n + ": read-only bind mount (RW=false)")
            self.assertEqual(t14.env_of(s).get("LIMS_INSTRUMENTS_RELEASES_DIR"), MOUNT_DST, n)

    def test_only_api_sees_the_release_store(self):
        for n, s in t14.compose()["services"].items():
            if n in t14.API:
                continue
            for src, dst, ro in t14.volumes_of(s):
                self.assertNotIn("agent-releases", src + dst, "%s must not mount the release store" % n)
            self.assertNotIn("LIMS_INSTRUMENTS_RELEASES_DIR", t14.env_of(s), n)

    def test_no_writable_release_mount_anywhere(self):
        for n, s in t14.compose()["services"].items():
            for src, dst, ro in t14.volumes_of(s):
                if "agent-releases" in src or "agent-releases" in dst:
                    self.assertTrue(ro, n)

    def test_config_signing_key_only_api_and_worker(self):
        who = set(t14.API + t14.WORKERS)
        for n, s in t14.compose()["services"].items():
            e = t14.env_of(s)
            for var in ("LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE", "LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_ID"):
                if n in who:
                    self.assertTrue(e.get(var), "%s: %s required (02-TRD s7.4)" % (n, var))
                else:
                    self.assertNotIn(var, e, "%s must not get the config-signing key" % n)
        for n in who:
            self.assertEqual(t14.env_of(t14.svc(n))["LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE"],
                             "/run/secrets/lims/" + CFG_KEY)

    def test_release_secrets_in_no_container(self):  # AC-19.3 compose half
        blob = json.dumps(t14.compose())
        for sid in (KEY, CERT):
            self.assertNotIn(sid, blob, sid + " is visible to a product container")
        self.assertNotIn("/secrets/release", blob)
        self.assertNotIn("release", t14.compose()["services"], "no compose service named like the ops-1 release service")


# ------------------------------------------------------------------------------------------------ render target (AC-19.3)
class RenderTargetTest(unittest.TestCase):
    def test_placement_ops_release_only(self):
        p = yaml.safe_load(txt(PLACEMENT))["secrets_render_placement"]
        for sid in (KEY, CERT):
            self.assertEqual(p[sid]["hosts"], ["ops"], sid)
            self.assertEqual(p[sid]["services"], ["release"], sid)
        self.assertEqual(p[CFG_KEY]["hosts"], ["app"])
        self.assertEqual(sorted(p[CFG_KEY]["services"]), ["api-a", "api-b", "worker-a", "worker-b"])

    def test_no_other_placement_names_the_release_secrets(self):
        p = yaml.safe_load(txt(PLACEMENT))
        for table in ("secrets_render_placement", "secrets_render_prefix_placement"):
            for k, v in p[table].items():
                if k in (KEY, CERT):
                    continue
                self.assertNotIn("release", v.get("services", []), k)
                self.assertFalse(k.startswith(("instruments_release", "instruments_authenticode")), k)

    def test_schema_consumers_are_the_release_service(self):
        for env in ("dev", "staging", "prod"):
            ids = {e["id"]: e for e in yaml.safe_load(txt(SCHEMAS / ("%s.secrets.schema.yaml" % env)))["secrets"]}
            for sid in (KEY, CERT):
                self.assertEqual(ids[sid]["consumers"], ["ops-1 release service"], env + " " + sid)
            self.assertEqual(sorted(ids[CFG_KEY]["consumers"]), ["api-a", "api-b", "worker-a", "worker-b"])

    def test_full_inventories_keep_ops_and_app_disjoint(self):  # keys never on app-1
        checked = 0
        for inv in sorted(INVENTORIES.iterdir()):
            gv = inv / "group_vars" / "all.yml"
            if not gv.exists() or yaml.safe_load(gv.read_text(encoding="utf-8")).get("topology_profile") != "full":
                continue
            ch = yaml.safe_load((inv / "hosts.yml").read_text(encoding="utf-8"))["all"]["children"]
            ops, app = set(ch["ops"]["hosts"]), set(ch["app"]["hosts"])
            self.assertTrue(ops and app, inv.name)
            self.assertEqual(ops & app, set(), "%s: release keys would land on an app host" % inv.name)
            checked += 1
        self.assertGreaterEqual(checked, 1, "no full-profile inventory found")


# ------------------------------------------------------------------------------------------------ deploy.yml step
def _flatten(tasks, play, out):
    for t in tasks or []:
        if "block" in t:
            _flatten(t["block"], play, out)
            _flatten(t.get("rescue"), play, out)
            _flatten(t.get("always"), play, out)
        out.append((play, t))


def _all_tasks():
    out = []
    for play in ylo(DEPLOY):
        _flatten(play.get("pre_tasks"), play, out)
        _flatten(play.get("tasks"), play, out)
    return out


class DeployStepTest(unittest.TestCase):
    def step(self):
        hits = [(i, p, t) for i, (p, t) in enumerate(_all_tasks()) if re.search(r"agent[_ -]release", json.dumps(t), re.I)]
        self.assertTrue(hits, "deploy.yml has no agent-release step (02-TRD s7.11)")
        return hits

    def test_guarded_by_release_manifest(self):
        for _, _, t in self.step():
            w = json.dumps(t.get("when", ""))
            self.assertRegex(w, r"(?i)manifest|agent_release", "step must run only when a release manifest is present: " + w)

    def test_runs_on_ops_after_the_seed_step(self):
        seeds = [i for i, (p, t) in enumerate(_all_tasks()) if "seeds" in str(t.get("name", "")).lower()]
        self.assertTrue(seeds)
        for i, p, t in self.step():
            on_ops = p.get("hosts") == "ops" or "ops" in str(t.get("delegate_to", ""))
            self.assertTrue(on_ops or "migrate" in json.dumps(t), "keys are used on ops only")
            if re.search(r"agent-release\.sh", json.dumps(t)):
                self.assertTrue(on_ops, "agent-release.sh must run on the ops host")
            self.assertGreater(i, seeds[0], "g_agent_releases exists only after migrations")

    def test_no_secret_in_environment_or_argv(self):
        for _, _, t in self.step():
            self.assertNotRegex(json.dumps(t), r"instruments_(release_signing_key|authenticode_cert)\b.*(content|value|lookup)")


# ------------------------------------------------------------------------------------------------ lean + full parity
class ProfileTest(unittest.TestCase):
    def test_no_host_name_pinned_in_artefacts(self):
        for p in (SCRIPT,) + tuple(f for f in ROLE.rglob("*") if f.is_file()):
            self.assertNotRegex(code(p), r"\b(prod|staging|backup|dr)-[0-9a-z]\b|\b(app|data)-1\b", p.name)


if __name__ == "__main__":
    unittest.main()
