"""T-24 tests (tester role): CI/CD scripts (build/scan/push/deploy/smoke/rollback/promote), deploy.yml app part, role ci_runner.

Covers 02-TRD s12.1-12.3 (envs, build, deploy steps 1-8), s7.9 (deploy flow; pre-deploy backup prod only), s12.2 (runner isolation),
AC-20.1 (build/scan/push by digest/deploy dev), AC-20.2 (staging: migrations+registry-sync+smoke; prod: approval + pre-backup incr),
AC-20.3 (failed smoke -> previous digests redeployed, DeployRolledBack counter), AC-21.1 (distinct envs: lock/inventory/secret
file never cross), AC-21.2 (non-prod: mail sink, synthetic seeds), 07-SEC A9 (PR code never on the runner, digest pinning, trivy,
no prod key on the runner, approval-gated decrypt), CR-C1-001 (default = operators run infra/ci/*.sh manually), LD-45 (both
topology profiles; host names are read from the active profile, never literal).

NOT provable here (needs ops-1 + docker + registry + ansible; no ansible/trivy/docker on Windows, LD-17): real build/scan/push, a real
`ansible-playbook` run, real smoke journeys, the systemd units, the GitHub workflow wrappers (C0-owned, CR-C1-001), and the prod
pre-flight "last drill < 35 days / no backup-family page firing" (no data source is named in the spec). Pipeline tests in dev/staging
(06-PLAN) = the live run of these scripts on a dev/staging runner; scripts are proven here against fakes of docker/trivy/ansible-playbook.

CONTRACTS where the TRD is silent (writer must meet them; ambiguity -> dispute, not a silent change). Env vars are test seams:
 * All scripts: bash, LF, `set -euo pipefail`, no eval, no curl|sh, no secret on a command line, no `:latest`. Bad arguments -> exit 2
   BEFORE any docker/trivy/ansible call. Siblings are called as "$HERE/<name>.sh" (tests copy infra/ci to a temp tree and stub siblings).
   Repo root = $HERE/../.. . RELEASES_DIR overrides <root>/infra/releases (as release-lock.sh). Envs: dev|staging|prod.
 * build.sh <release>: `docker build` per image with `-t <name>:<release>` (never :latest, never pushes, no secret-looking --build-arg);
   failure of any build -> non-zero. release = [A-Za-z0-9][A-Za-z0-9._-]{0,63}.
 * scan.sh <repo-ref@sha256:hex>...: `trivy image` per image; the SCRIPT decides from the JSON report (fake trivy ignores
   --exit-code/--ignorefile/--severity, exits 0 and writes the Trivy JSON schema to --output or stdout, or an SBOM for --format
   cyclonedx|spdx*). Any CRITICAL vulnerability fails (exit 1, id named on stderr/stdout) unless TRIAGE_FILE (default infra/ci/trivy-triage.yaml,
   YAML `entries: [{id, added, expires}]`, ISO-8601 UTC) holds the id with now < expires and expires - added <= 72 h. trivy failing
   or no report -> non-zero (fail closed). SBOM: one non-empty CycloneDX/SPDX file per image in SBOM_DIR (default infra/releases/sbom).
 * deploy.sh <env> <release>: release `v1.2.3` (prod), `v1.2.3-rc.1` (staging), [A-Za-z0-9._-]+ (dev). Reads <RELEASES_DIR>/<env>.lock.yaml
   (its `env:` must equal <env>, else refuse: AC-21.1). Refuses (no ansible) when the drill lock exists (LIMS_DRILL_LOCK, default
   /var/lock/lims-drill) or, for prod, LIMS_APPROVED_RELEASE != <release>. Runs `ansible-playbook -i <inventories/DIR> .../playbooks/deploy.yml`
   (DIR = LIMS_INVENTORY or a default; its group_vars/all.yml `env:` must equal <env>) with, for every lock key `lims/<name>`,
   `deploy_<name with - as _>_image=<ref>` (as -e k=v or -e @file) and the release id. Then "$HERE/smoke.sh" <env>. Smoke fails ->
   "$HERE/rollback.sh" <env>, exit non-zero. Smoke ok -> copy of the lock to <RELEASES_DIR>/<env>.deployed.lock.yaml (last known good), exit 0.
   ansible-playbook fails -> non-zero, smoke not run.
 * rollback.sh <env>: reads <RELEASES_DIR>/<env>.deployed.lock.yaml, runs deploy.yml with THOSE digests (same -e shape), increments
   counter `lims_ops_deploy_rolled_back_total` (optional labels) in a *.prom file in TEXTFILE_DIR (default /var/lib/node_exporter/textfile;
   atomic). No deployed lock -> non-zero, no ansible, counter untouched. ansible failure -> non-zero, counter untouched.
 * smoke.sh <env>: runs tests/external/*; SMOKE_INDUCE_FAILURE=1 -> exit 1 at once, no network (rollback drill); refused (exit 2) in prod.
 * promote.sh <from> <to>: only dev->staging and staging->prod. Copies <from>.deployed.lock.yaml to <to>.lock.yaml with `env: <to>`, same
   image digests. Missing deployed lock / other pair -> non-zero, nothing written.
 * deploy.yml (inline tasks, named): prod-only `pgbackrest backup --type=incr --repo=1` BEFORE the migrations, in a play on group `data`
   with any_errors_fatal (or delegated to groups['data']); precondition assert has @sha256 for deploy_{api,worker,web,portal,renderer,pdf_sandbox}_image;
   rolling `docker compose ... up` tasks after the seeds in order api-a, api-b, worker-a[, worker-b full only], web-a[, web-b full only],
   portal, renderer, pdf-sandbox (topology_profile lean|full), readiness between api-a and api-b; an assert/fail task: when env != prod,
   smoke target `smtp_relay_fqdn` must equal `mail_sink_fqdn` (AC-21.2); an ops-note.sh release record at the end.
 * role ci_runner on group `ops` (site.yml, after `registry`): defaults ci_runner_user (non-root), ci_runner_labels `nepal-ops`;
   systemd units lims-ci-runner.service (User= non-root) and lims-prod-decrypt.service (root, takes the release id); no key file owned by the runner.
Stdlib + jinja2 + PyYAML + bash. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t24_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_t08_db_flow as t08  # noqa: E402  (helpers only; its TestCases are not re-collected)

ROOT = Path(__file__).resolve().parents[3]
CI = ROOT / "infra" / "ci"
ROLE = ROOT / "infra" / "ansible" / "roles" / "ci_runner"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
DEPLOY = ROOT / "infra" / "ansible" / "playbooks" / "deploy.yml"
INV = ROOT / "infra" / "ansible" / "inventories"
REG = "registry.lims.internal:5000"
SCRIPTS = ["build", "scan", "deploy", "smoke", "rollback", "promote"]
NAMES = ["api", "worker", "web", "portal", "renderer", "pdf-sandbox"]


def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def _need(p):
    if not p.exists():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p


def _code(p):
    return "\n".join(l for l in _need(p).read_text(encoding="utf-8").splitlines() if not l.lstrip().startswith("#"))


def dg(c):
    return "sha256:" + c * 64


def ref(name, c):
    return "%s/lims/%s@%s" % (REG, name, dg(c))


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def lock_text(env, refs):
    return "env: %s\nimages:\n%s" % (env, "".join('  "lims/%s": "%s"\n' % (n, r) for n, r in refs.items()))


OLD = {n: ref(n, "a") for n in NAMES}
NEW = {n: ref(n, "b") for n in NAMES}

FAKE_LOGGER = '''#!/usr/bin/env bash
{ echo "--call $(basename "$0")"; for a in "$@"; do echo "A:$a"; case "$a" in @*) [ -f "${a#@}" ] && echo "F:$(tr '\\n' ' ' < "${a#@}")";; esac; done; } >> "$FAKE_LOG"
%s
'''
FAKES = {
    # logs SOPS_AGE_KEY_FILE to "$FAKE_LOG.sops"; FAKE_TOUCH_MARKER=1 -> touches the `-e deploy_roll_marker=<path>` file (rolling update began)
    "ansible-playbook": '''printf '%s\\n' "${SOPS_AGE_KEY_FILE-UNSET}" >> "$FAKE_LOG.sops"
if [ -n "${FAKE_TOUCH_MARKER:-}" ]; then for a in "$@"; do case "$a" in deploy_roll_marker=*) : > "${a#deploy_roll_marker=}";; esac; done; fi
exit "${FAKE_ANSIBLE_RC:-0}"''',
    "docker": '''case "$1" in
  build|buildx) [ "${FAKE_BUILD_RC:-0}" = 0 ] || exit "$FAKE_BUILD_RC" ;;
  push) h=$(printf %s "$2" | sha256sum | cut -c1-64); echo "x: digest: sha256:$h size: 1" ;;
esac
exit 0''',
    "trivy": '''out=""; fmt=json; prev=""
for a in "$@"; do [ "$prev" = --output ] && out=$a; [ "$prev" = --format ] && fmt=$a; prev=$a; done
[ -z "${FAKE_TRIVY_RC:-}" ] || exit "$FAKE_TRIVY_RC"
case "$fmt" in
  json) body=$(cat "${FAKE_TRIVY_JSON:-/dev/null}") ;;
  cyclonedx) body='{"bomFormat":"CycloneDX","specVersion":"1.5"}' ;;
  *) body='{"spdxVersion":"SPDX-2.3"}' ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
exit 0''',
}
# Git-for-Windows bash has no flock(1): the fake logs to FAKE_FLOCK_LOG (NOT FAKE_LOG, so call-sequence asserts stay as they are)
# and exits FAKE_FLOCK_RC (1 = what `flock -w N` returns when the lock stays held). Real mutual exclusion is NOT provable here.
FAKE_FLOCK = '#!/usr/bin/env bash\n{ echo "--call flock"; for a in "$@"; do echo "A:$a"; done; } >> "$FAKE_FLOCK_LOG"\nexit "${FAKE_FLOCK_RC:-0}"\n'
STUB_SMOKE ='#!/usr/bin/env bash\necho "--call smoke.sh" >> "$FAKE_LOG"; for a in "$@"; do echo "A:$a" >> "$FAKE_LOG"; done\nexit "${SMOKE_RC:-0}"\n'
STUB_ROLLBACK = '#!/usr/bin/env bash\necho "--call rollback.sh" >> "$FAKE_LOG"; for a in "$@"; do echo "A:$a" >> "$FAKE_LOG"; done\nexit "${ROLLBACK_RC:-0}"\n'


class Rig:
    """Temp repo tree: copies of infra/ci, inventories, deploy.yml; fakes on PATH; shared call log."""

    def __init__(self, stub_siblings=False):
        self.tmp = Path(tempfile.mkdtemp(prefix="t24"))
        self.root = self.tmp / "repo"
        self.ci = self.root / "infra" / "ci"
        self.rel = self.root / "infra" / "releases"
        self.bin = self.tmp / "bin"
        self.log = self.tmp / "calls.log"
        self.tf = self.tmp / "textfile"
        self.drill = self.tmp / "no-such-drill-lock"
        for d in (self.ci, self.rel, self.bin, self.tf, self.root / "infra" / "ansible" / "playbooks"):
            d.mkdir(parents=True, exist_ok=True)
        if CI.is_dir():
            for p in CI.glob("*"):
                if p.is_file():
                    shutil.copy(p, self.ci / p.name)
        if INV.is_dir():
            shutil.copytree(INV, self.root / "infra" / "ansible" / "inventories")
        if DEPLOY.is_file():
            shutil.copy(DEPLOY, self.root / "infra" / "ansible" / "playbooks" / "deploy.yml")
        if (ROOT / "infra" / "tests" / "external").is_dir():
            shutil.copytree(ROOT / "infra" / "tests" / "external", self.root / "infra" / "tests" / "external")
        self.flock_log = self.tmp / "flock.log"
        self.locks = self.tmp / "locks"
        self.locks.mkdir()
        self.key = self.tmp / "ci-prod-age.key"  # stands in for the key lims-prod-decrypt@<release> releases (never a real key)
        self.key.write_text("synthetic placeholder, not a key\n", encoding="utf-8")
        (self.bin / "flock").write_text(FAKE_FLOCK, encoding="utf-8", newline="\n")
        self.flock_log.write_text("", encoding="utf-8")
        for n, body in FAKES.items():
            (self.bin / n).write_text(FAKE_LOGGER % body, encoding="utf-8", newline="\n")
        if stub_siblings:
            (self.ci / "smoke.sh").write_text(STUB_SMOKE, encoding="utf-8", newline="\n")
            (self.ci / "rollback.sh").write_text(STUB_ROLLBACK, encoding="utf-8", newline="\n")
        self.log.write_text("", encoding="utf-8")

    def close(self):
        shutil.rmtree(self.tmp, True)

    def put_lock(self, env, refs, name=None):
        (self.rel / (name or "%s.lock.yaml" % env)).write_text(lock_text(env, refs), encoding="utf-8", newline="\n")

    def run(self, script, *args, env=None):
        p = self.ci / (script + ".sh")
        if not p.exists():
            raise AssertionError("missing file infra/ci/%s.sh" % script)
        e = dict(os.environ, FAKE_LOG=self.log.as_posix(), RELEASES_DIR=self.rel.as_posix(), TEXTFILE_DIR=self.tf.as_posix(),
                 LIMS_DRILL_LOCK=self.drill.as_posix(), SBOM_DIR=(self.tmp / "sbom").as_posix(),
                 FAKE_FLOCK_LOG=self.flock_log.as_posix(), LIMS_DEPLOY_LOCK_DIR=self.locks.as_posix(),
                 LIMS_PROD_KEY_FILE=self.key.as_posix(),
                 PATH=self.bin.as_posix() + os.pathsep + os.environ.get("PATH", ""))
        for k in ("LIMS_APPROVED_RELEASE", "LIMS_INVENTORY", "SMOKE_INDUCE_FAILURE", "TRIAGE_FILE", "LIMS_ENV_LOCK_HELD",
                  "SOPS_AGE_KEY_FILE", "FAKE_FLOCK_RC", "FAKE_TOUCH_MARKER"):
            e.pop(k, None)
        e.update(env or {})
        r = subprocess.run([_bash(), p.as_posix(), *args], env=e, capture_output=True, text=True, timeout=120, cwd=self.root.as_posix())
        if "not implemented" in r.stderr:
            raise AssertionError("infra/ci/%s.sh is still the T-01 stub" % script)
        return r

    def calls(self, name=None):
        out, cur = [], None
        for line in self.log.read_text(encoding="utf-8").splitlines():
            if line.startswith("--call "):
                cur = {"name": line[7:], "args": [], "files": []}
                out.append(cur)
            elif cur is not None and line.startswith("A:"):
                cur["args"].append(line[2:])
            elif cur is not None and line.startswith("F:"):
                cur["files"].append(line[2:])
        return [c for c in out if name is None or c["name"] == name]

    def names(self):
        return [c["name"] for c in self.calls()]

    def flock_calls(self):
        out = []
        for line in self.flock_log.read_text(encoding="utf-8").splitlines():
            if line.startswith("--call "):
                out.append([])
            elif line.startswith("A:") and out:
                out[-1].append(line[2:])
        return out

    def sops_keys(self):  # SOPS_AGE_KEY_FILE seen by each ansible-playbook run ("UNSET" when absent)
        p = Path(self.log.as_posix() + ".sops")
        return p.read_text(encoding="utf-8").splitlines() if p.exists() else []

    @staticmethod
    def text(call):
        return "\n".join(call["args"] + call["files"])


class Base(unittest.TestCase):
    stub = False

    def setUp(self):
        self.rig = Rig(self.stub)
        self.addCleanup(self.rig.close)


# =============================================================== static: every script
class ScriptStaticTest(unittest.TestCase):
    def test_scripts_exist_not_stubs_strict_lf(self):
        for n in SCRIPTS:
            t = _need(CI / (n + ".sh")).read_bytes().decode("utf-8")
            self.assertNotIn("not implemented yet", t, n)
            self.assertNotIn("\r", t, n + ": LF only")
            self.assertTrue(t.startswith("#!"), n)
            self.assertRegex(t, r"set -[a-z]*e[a-z]*u[a-z]*o pipefail|set -euo pipefail", n)

    def test_bash_syntax(self):
        for n in SCRIPTS:
            r = subprocess.run([_bash(), "-n", _need(CI / (n + ".sh")).as_posix()], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, "%s: %s" % (n, r.stderr))

    def test_no_eval_pipe_to_shell_secret_args_or_floating_tags(self):
        for n in SCRIPTS:
            c = _code(CI / (n + ".sh"))
            self.assertNotRegex(c, r"\beval\b", n)
            self.assertNotRegex(c, r"(curl|wget)[^\n]*\|\s*(ba)?sh", n)
            self.assertNotRegex(c, r":latest\b", n + ": tags float; digests pin")
            self.assertNotRegex(c, r"docker login[^\n]*(\s-p\b|--password(\s|=))", n)

    def test_runner_never_reads_a_prod_age_key(self):  # 07-SEC A9: no age key on the runner
        for n in SCRIPTS:
            c = _code(CI / (n + ".sh"))
            self.assertNotRegex(c, r"(?i)age-keygen|SOPS_AGE_KEY|keys\.txt|AGE-SECRET", n)

    def test_lib_deploy_uses_only_the_released_key_file(self):  # review item 4; 02-TRD s12.2: no key material of its own on the runner
        c = _code(CI / "lib-deploy.sh")
        self.assertNotRegex(c, r"(?i)age-keygen|keys\.txt|AGE-SECRET|SOPS_AGE_KEY(?!_FILE)")
        self.assertIn("LIMS_PROD_KEY_FILE", c)
        self.assertIn("/run/lims/ci-prod/age.key", c)
        self.assertIn("SOPS_AGE_KEY_FILE", c)

    def test_only_nepal_registry_in_scripts(self):
        for n in SCRIPTS:
            c = _code(CI / (n + ".sh"))
            for f in ("docker.io", "ghcr.io", "quay.io", "gcr.io", "public.ecr.aws", "registry-1.docker.io"):
                self.assertNotIn(f, c, "%s names foreign registry %s" % (n, f))

    def test_smoke_runs_the_external_suite(self):
        c = _code(CI / "smoke.sh")
        self.assertIn("tests/external", c)

    def test_default_trivy_triage_file_is_valid(self):  # 04 I9: expiry <= 72 h
        p = _need(CI / "trivy-triage.yaml")
        doc = yaml.safe_load(p.read_text(encoding="utf-8"))
        self.assertIsInstance(doc, dict)
        self.assertIsInstance(doc.get("entries"), list, "`entries:` list required (may be empty)")
        for e in doc["entries"]:
            self.assertRegex(str(e.get("id", "")), r"^(CVE-\d{4}-\d{4,}|GHSA-[\w-]+)$")
            a = datetime.fromisoformat(str(e["added"]).replace("Z", "+00:00"))
            x = datetime.fromisoformat(str(e["expires"]).replace("Z", "+00:00"))
            self.assertLessEqual(x - a, timedelta(hours=72), "triage entry %s lives > 72 h" % e["id"])


# =============================================================== argument validation (all scripts)
class ArgumentTest(Base):
    def test_bad_env_is_exit_2_with_no_tool_call(self):
        for script, extra in (("deploy", ["v1.0.0"]), ("rollback", []), ("smoke", []), ("promote", ["dev"])):
            for bad in ("", "qa", "PROD", "prod;id", "../prod", "dev staging"):
                r = self.rig.run(script, bad, *extra)
                self.assertEqual(r.returncode, 2, "%s %r: %s" % (script, bad, r.stderr))
        self.assertEqual(self.rig.calls(), [], "a bad env reached a tool")

    def test_build_rejects_bad_release_before_docker(self):
        for bad in ("", "a b", "v1;rm -rf /", "$(id)", "-x", "a" * 80, "../x", "x\ny"):
            r = self.rig.run("build", bad)
            self.assertEqual(r.returncode, 2, "build %r" % bad)
        self.assertEqual(self.rig.calls(), [])

    def test_scan_rejects_tag_refs_before_trivy(self):  # digest pinning (A9)
        for bad in ("%s/lims/api:latest" % REG, "%s/lims/api:v1" % REG, "lims/api", "", "x@sha256:12"):
            r = self.rig.run("scan", bad)
            self.assertEqual(r.returncode, 2, "scan %r" % bad)
        self.assertEqual(self.rig.run("scan").returncode, 2, "no image")
        self.assertEqual(self.rig.calls(), [])

    def test_deploy_rejects_wrong_release_shape_per_env(self):
        self.rig.put_lock("prod", NEW)
        self.rig.put_lock("staging", NEW)
        cases = [("prod", "v1.2.3-rc.1"), ("prod", "1.2.3"), ("prod", "latest"), ("prod", "v1.2.3;id"),
                 ("staging", "v1.2.3"), ("staging", "v1.2.3-rc"), ("dev", "a b"), ("dev", "$(id)"), ("dev", "")]
        for env, rel in cases:
            r = self.rig.run("deploy", env, rel, env={"LIMS_APPROVED_RELEASE": rel})
            self.assertEqual(r.returncode, 2, "deploy %s %r" % (env, rel))
        self.assertEqual(self.rig.calls("ansible-playbook"), [], "ansible reached with a bad release id")


# =============================================================== build.sh
class BuildTest(Base):
    def test_builds_tag_release_never_push_never_latest(self):
        r = self.rig.run("build", "v1.2.3-rc.1")
        self.assertEqual(r.returncode, 0, r.stderr)
        builds = [c for c in self.rig.calls("docker") if c["args"][:1] in (["build"], ["buildx"])]
        self.assertTrue(builds, "no docker build call")
        for c in builds:
            tags = [c["args"][i + 1] for i, a in enumerate(c["args"]) if a in ("-t", "--tag")]
            self.assertTrue(tags, "build without -t")
            for t in tags:
                self.assertTrue(t.endswith(":v1.2.3-rc.1"), t)
            for a in c["args"]:
                if a.startswith("--build-arg") or "=" in a:
                    self.assertNotRegex(a, r"(?i)(secret|password|token|passwd|private)[A-Za-z_]*=", "secret via build-arg leaks into image history")
        self.assertFalse([c for c in self.rig.calls("docker") if c["args"][:1] == ["push"]], "build.sh must not push")

    def test_build_failure_is_nonzero(self):
        r = self.rig.run("build", "v1.0.0", env={"FAKE_BUILD_RC": "1"})
        self.assertNotEqual(r.returncode, 0)


# =============================================================== scan.sh
class ScanTest(Base):
    def report(self, vulns):
        p = self.rig.tmp / "report.json"
        p.write_text(json.dumps({"Results": [{"Target": "t", "Vulnerabilities": vulns}] if vulns is not None else None}), encoding="utf-8")
        return p

    def triage(self, entries):
        p = self.rig.tmp / "triage.yaml"
        p.write_text(yaml.safe_dump({"entries": entries}), encoding="utf-8")
        return p

    def scan(self, vulns, entries=None, **env):
        e = {"FAKE_TRIVY_JSON": self.report(vulns).as_posix(), "TRIAGE_FILE": self.triage(entries or []).as_posix()}
        e.update(env)
        return self.rig.run("scan", ref("api", "a"), env=e)

    CRIT = {"VulnerabilityID": "CVE-2026-1111", "Severity": "CRITICAL", "FixedVersion": "1.2.3"}
    CRIT_UNFIXED = {"VulnerabilityID": "CVE-2026-2222", "Severity": "CRITICAL"}

    def entry(self, cid, hours_valid=48, life=48, ago=1):
        now = datetime.now(timezone.utc)
        added = now - timedelta(hours=ago)
        return {"id": cid, "added": iso(added), "expires": iso(added + timedelta(hours=life))} if hours_valid else None

    def test_clean_report_passes_and_writes_sbom(self):
        r = self.scan(None)
        self.assertEqual(r.returncode, 0, r.stderr)
        sb = list((self.rig.tmp / "sbom").glob("*")) if (self.rig.tmp / "sbom").exists() else []
        self.assertTrue(sb and all(p.stat().st_size > 0 for p in sb), "no SBOM written")
        self.assertRegex(sb[0].read_text(encoding="utf-8"), r"CycloneDX|SPDX")

    def test_high_only_passes(self):
        self.assertEqual(self.scan([{"VulnerabilityID": "CVE-2026-3333", "Severity": "HIGH"}]).returncode, 0)

    def test_critical_without_triage_fails_and_names_the_cve(self):
        for v in (self.CRIT, self.CRIT_UNFIXED):
            r = self.scan([v])
            self.assertEqual(r.returncode, 1, v["VulnerabilityID"] + r.stderr)
            self.assertIn(v["VulnerabilityID"], r.stdout + r.stderr)

    def test_valid_triage_entry_allows_that_cve_only(self):
        ok = self.entry("CVE-2026-1111")
        self.assertEqual(self.scan([self.CRIT], [ok]).returncode, 0)
        r = self.scan([self.CRIT, self.CRIT_UNFIXED], [ok])
        self.assertEqual(r.returncode, 1, "second critical has no entry")
        self.assertIn("CVE-2026-2222", r.stdout + r.stderr)

    def test_expired_triage_entry_does_not_count(self):
        self.assertEqual(self.scan([self.CRIT], [self.entry("CVE-2026-1111", ago=50, life=48)]).returncode, 1)

    def test_triage_entry_longer_than_72h_does_not_count(self):  # 04 I9
        self.assertEqual(self.scan([self.CRIT], [self.entry("CVE-2026-1111", ago=1, life=96)]).returncode, 1)

    def test_malformed_triage_entry_fails_closed(self):
        for bad in ({"id": "CVE-2026-1111"}, {"id": "CVE-2026-1111", "added": "soon", "expires": "later"}):
            self.assertNotEqual(self.scan([self.CRIT], [bad]).returncode, 0)

    def test_scanner_failure_or_no_report_fails_closed(self):
        r = self.scan(None, FAKE_TRIVY_RC="2")
        self.assertNotEqual(r.returncode, 0)
        p = self.rig.tmp / "empty.json"
        p.write_text("", encoding="utf-8")
        r = self.rig.run("scan", ref("api", "a"), env={"FAKE_TRIVY_JSON": p.as_posix(), "TRIAGE_FILE": self.triage([]).as_posix()})
        self.assertNotEqual(r.returncode, 0, "empty report is not a pass")

    def test_every_image_is_scanned(self):
        p = self.report(None)
        r = self.rig.run("scan", ref("api", "a"), ref("web", "b"),
                         env={"FAKE_TRIVY_JSON": p.as_posix(), "TRIAGE_FILE": self.triage([]).as_posix()})
        self.assertEqual(r.returncode, 0, r.stderr)
        scanned = " ".join(self.rig.text(c) for c in self.rig.calls("trivy"))
        self.assertIn(dg("a"), scanned)
        self.assertIn(dg("b"), scanned)


# =============================================================== deploy.sh
class DeployTest(Base):
    stub = True

    def deploy(self, env, rel, **e):
        return self.rig.run("deploy", env, rel, env=e)

    def seq(self):
        return self.rig.names()

    def test_dev_deploy_runs_ansible_then_smoke_and_records_known_good(self):  # AC-20.1
        self.rig.put_lock("dev", NEW)
        r = self.deploy("dev", "dev-20261111")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.seq(), ["ansible-playbook", "smoke.sh"])
        a = self.rig.text(self.rig.calls("ansible-playbook")[0])
        self.assertRegex(a, r"playbooks[/\\]deploy\.yml")
        for n in NAMES:
            self.assertIn("deploy_%s_image=%s" % (n.replace("-", "_"), NEW[n]) , a.replace('"', ""), n)
        self.assertIn("dev-20261111", a)
        self.assertEqual(self.rig.calls("smoke.sh")[0]["args"], ["dev"])
        self.assertTrue((self.rig.rel / "dev.deployed.lock.yaml").is_file(), "known-good lock not recorded")
        self.assertEqual(yaml.safe_load((self.rig.rel / "dev.deployed.lock.yaml").read_text(encoding="utf-8"))["images"],
                         {"lims/%s" % n: NEW[n] for n in NAMES})

    def test_inventory_matches_env_and_override_is_honoured(self):  # AC-21.1
        for env, rel in (("dev", "dev-1"), ("staging", "v1.0.0-rc.1")):
            self.rig.put_lock(env, NEW)
            self.assertEqual(self.deploy(env, rel).returncode, 0)
            argv = self.rig.calls("ansible-playbook")[-1]["args"]
            self.assertIn("-i", argv)
            inv = Path(argv[argv.index("-i") + 1])
            allv = yaml.safe_load((self.rig.root / "infra/ansible/inventories" / inv.name / "group_vars" / "all.yml").read_text(encoding="utf-8"))
            self.assertEqual(allv["env"], env, "inventory %s does not belong to %s" % (inv.name, env))
        self.rig.put_lock("prod", NEW)
        r = self.deploy("prod", "v1.0.0", LIMS_APPROVED_RELEASE="v1.0.0", LIMS_INVENTORY="prod-lean")
        self.assertEqual(r.returncode, 0, r.stderr)
        argv = self.rig.calls("ansible-playbook")[-1]["args"]
        self.assertEqual(Path(argv[argv.index("-i") + 1]).name, "prod-lean")

    def test_cross_env_inventory_or_lock_is_refused(self):  # AC-21.1: no path between envs
        self.rig.put_lock("staging", NEW)
        r = self.deploy("staging", "v1.0.0-rc.1", LIMS_INVENTORY="prod-lean")
        self.assertNotEqual(r.returncode, 0, "staging deploy against the prod inventory")
        self.rig.put_lock("dev", NEW, name="dev.lock.yaml")
        (self.rig.rel / "staging.lock.yaml").write_text(lock_text("prod", NEW), encoding="utf-8", newline="\n")
        r = self.deploy("staging", "v1.0.0-rc.1")
        self.assertNotEqual(r.returncode, 0, "staging.lock.yaml says env: prod")
        self.assertEqual(self.rig.calls("ansible-playbook"), [])

    def test_missing_lock_refused(self):
        r = self.deploy("dev", "dev-1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls(), [])

    def test_drill_lock_blocks_deploy(self):  # 02-TRD 12.3 step 1
        self.rig.put_lock("dev", NEW)
        self.rig.drill.write_text("held", encoding="utf-8")
        r = self.deploy("dev", "dev-1")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls(), [], "deploy ran while the restore drill lock was held")

    def test_prod_requires_matching_approval_id(self):  # AC-20.2
        self.rig.put_lock("prod", NEW)
        for env in ({}, {"LIMS_APPROVED_RELEASE": ""}, {"LIMS_APPROVED_RELEASE": "v1.0.1"}, {"LIMS_APPROVED_RELEASE": "v1.0.0 "}):
            r = self.deploy("prod", "v1.0.0", **env)
            self.assertNotEqual(r.returncode, 0, "prod deploy without a matching approval: %r" % env)
        self.assertEqual(self.rig.calls(), [], "ansible/smoke reached without approval")
        r = self.deploy("prod", "v1.0.0", LIMS_APPROVED_RELEASE="v1.0.0")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.seq(), ["ansible-playbook", "smoke.sh"])

    def test_approval_is_not_required_below_prod(self):
        self.rig.put_lock("staging", NEW)
        self.assertEqual(self.deploy("staging", "v1.0.0-rc.1").returncode, 0)

    def test_failed_smoke_rolls_back_and_fails(self):  # AC-20.3 / done_when "induced smoke failure rolls back"
        for env, rel, extra in (("prod", "v1.0.0", {"LIMS_APPROVED_RELEASE": "v1.0.0"}), ("staging", "v1.0.0-rc.1", {}), ("dev", "dev-1", {})):
            self.rig.log.write_text("", encoding="utf-8")
            self.rig.put_lock(env, NEW)
            (self.rig.rel / ("%s.deployed.lock.yaml" % env)).write_text(lock_text(env, OLD), encoding="utf-8", newline="\n")
            r = self.deploy(env, rel, SMOKE_RC="1", **extra)
            self.assertNotEqual(r.returncode, 0, env + ": a rolled-back deploy must not report success")
            self.assertEqual(self.seq(), ["ansible-playbook", "smoke.sh", "rollback.sh"], env)
            self.assertEqual(self.rig.calls("rollback.sh")[0]["args"], [env])
            kg = yaml.safe_load((self.rig.rel / ("%s.deployed.lock.yaml" % env)).read_text(encoding="utf-8"))["images"]
            self.assertEqual(kg, {"lims/%s" % n: OLD[n] for n in NAMES}, env + ": known-good lock must stay the OLD digests")

    def test_ansible_failure_stops_before_smoke(self):  # 02-TRD 7.9 step 3
        self.rig.put_lock("dev", NEW)
        r = self.deploy("dev", "dev-1", FAKE_ANSIBLE_RC="2")
        self.assertNotEqual(r.returncode, 0)
        self.assertNotIn("smoke.sh", self.seq())
        self.assertFalse((self.rig.rel / "dev.deployed.lock.yaml").exists(), "failed deploy recorded as known good")

    def test_lock_with_foreign_registry_or_tag_is_refused(self):  # A9 digest pinning
        for bad in ("docker.io/library/nginx@" + dg("c"), REG + "/lims/api:latest"):
            (self.rig.rel / "dev.lock.yaml").write_text('env: dev\nimages:\n  "lims/api": "%s"\n' % bad, encoding="utf-8", newline="\n")
            r = self.deploy("dev", "dev-1")
            self.assertNotEqual(r.returncode, 0, bad)
        self.assertEqual(self.rig.calls("ansible-playbook"), [])


# =============================================================== rollback.sh
class RollbackTest(Base):
    def rb(self, env="prod", **e):
        return self.rig.run("rollback", env, env=e)

    def counter(self):
        total = 0
        files = list(self.rig.tf.glob("*.prom"))
        for f in files:
            for l in f.read_text(encoding="utf-8").splitlines():
                m = re.match(r"^lims_ops_deploy_rolled_back_total(\{[^}]*\})?\s+(\d+)(\.0+)?$", l)
                if m:
                    total += int(m.group(2))
        return total, files

    def setup_locks(self, env="prod"):
        self.rig.put_lock(env, NEW)
        (self.rig.rel / ("%s.deployed.lock.yaml" % env)).write_text(lock_text(env, OLD), encoding="utf-8", newline="\n")

    def test_redeploys_previous_digests_not_the_failed_ones(self):  # AC-20.3
        self.setup_locks()
        r = self.rb()
        self.assertEqual(r.returncode, 0, r.stderr)
        a = self.rig.text(self.rig.calls("ansible-playbook")[0]).replace('"', "")
        for n in NAMES:
            self.assertIn("deploy_%s_image=%s" % (n.replace("-", "_"), OLD[n]), a)
            self.assertNotIn(NEW[n], a, "rollback must not carry the failed digest")
        self.assertRegex(a, r"deploy\.yml")

    def test_counter_increments_each_rollback(self):  # alert DeployRolledBack
        self.setup_locks()
        self.assertEqual(self.rb().returncode, 0)
        n1, files = self.counter()
        self.assertEqual(n1, 1)
        self.assertEqual(self.rb().returncode, 0)
        self.assertEqual(self.counter()[0], 2, "counter must accumulate")
        self.assertEqual([p.name for p in self.rig.tf.iterdir() if not p.name.endswith(".prom")], [], "temp files left behind")
        txt = "\n".join(f.read_text(encoding="utf-8") for f in files)
        self.assertRegex(txt, r"# TYPE lims_ops_deploy_rolled_back_total counter")

    def test_no_known_good_means_failure_and_no_metric(self):
        self.rig.put_lock("prod", NEW)
        r = self.rb()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls("ansible-playbook"), [])
        self.assertEqual(self.counter()[0], 0)

    def test_failed_redeploy_is_nonzero_and_not_counted_as_rolled_back(self):
        self.setup_locks()
        r = self.rb(FAKE_ANSIBLE_RC="2")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.counter()[0], 0)

    def test_bad_inventory_env_pairing_refused(self):
        self.setup_locks("staging")
        r = self.rb("staging", LIMS_INVENTORY="prod-lean")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls("ansible-playbook"), [])


# =============================================================== smoke.sh / promote.sh
class SmokeTest(Base):
    def test_induced_failure_exits_1_without_network_in_nonprod(self):
        for env in ("dev", "staging"):
            r = self.rig.run("smoke", env, env={"SMOKE_INDUCE_FAILURE": "1"})
            self.assertEqual(r.returncode, 1, env + r.stderr)
            self.assertRegex(r.stdout + r.stderr, r"(?i)induced")

    def test_induced_failure_is_refused_in_prod(self):
        r = self.rig.run("smoke", "prod", env={"SMOKE_INDUCE_FAILURE": "1"})
        self.assertEqual(r.returncode, 2, "a pipeline variable must not be able to fake a prod outage")


class PromoteTest(Base):
    def test_staging_to_prod_copies_the_same_digests(self):  # env promotion: bits verified in staging are the bits in prod
        (self.rig.rel / "staging.deployed.lock.yaml").write_text(lock_text("staging", NEW), encoding="utf-8", newline="\n")
        r = self.rig.run("promote", "staging", "prod")
        self.assertEqual(r.returncode, 0, r.stderr)
        d = yaml.safe_load((self.rig.rel / "prod.lock.yaml").read_text(encoding="utf-8"))
        self.assertEqual(d["env"], "prod")
        self.assertEqual(d["images"], {"lims/%s" % n: NEW[n] for n in NAMES})
        self.assertEqual(self.rig.calls(), [], "promotion moves digests, it builds/pushes nothing")

    def test_dev_to_staging_ok(self):
        (self.rig.rel / "dev.deployed.lock.yaml").write_text(lock_text("dev", NEW), encoding="utf-8", newline="\n")
        self.assertEqual(self.rig.run("promote", "dev", "staging").returncode, 0)
        self.assertEqual(yaml.safe_load((self.rig.rel / "staging.lock.yaml").read_text(encoding="utf-8"))["env"], "staging")

    def test_only_forward_adjacent_pairs_and_never_unverified(self):
        for e in ("dev", "staging", "prod"):
            (self.rig.rel / ("%s.deployed.lock.yaml" % e)).write_text(lock_text(e, NEW), encoding="utf-8", newline="\n")
        before = {p.name for p in self.rig.rel.iterdir()}
        for a, b in (("dev", "prod"), ("prod", "staging"), ("staging", "dev"), ("prod", "dev"), ("dev", "dev"), ("prod", "prod")):
            self.assertNotEqual(self.rig.run("promote", a, b).returncode, 0, "%s -> %s" % (a, b))
        self.assertEqual({p.name for p in self.rig.rel.iterdir()}, before, "refused promotion wrote files")
        # only a deployed (smoke-verified) lock may be promoted; the raw lock of staging is not enough
        (self.rig.rel / "staging.deployed.lock.yaml").unlink()
        self.rig.put_lock("staging", NEW)
        self.assertNotEqual(self.rig.run("promote", "staging", "prod").returncode, 0)
        self.assertFalse((self.rig.rel / "prod.lock.yaml").exists())


# =============================================================== chain (AC-20.1, manual run per CR-C1-001)
class ChainTest(Base):
    stub = True

    def test_build_scan_push_deploy_dev(self):
        r = self.rig.run("build", "dev-1")
        self.assertEqual(r.returncode, 0, r.stderr)
        rep = self.rig.tmp / "clean.json"
        rep.write_text('{"Results":null}', encoding="utf-8")
        tri = self.rig.tmp / "tri.yaml"
        tri.write_text("entries: []\n", encoding="utf-8")
        self.assertEqual(self.rig.run("scan", ref("api", "c"), env={"FAKE_TRIVY_JSON": rep.as_posix(), "TRIAGE_FILE": tri.as_posix()}).returncode, 0)
        r = self.rig.run("push", "dev", "lims/api:dev-1")
        self.assertEqual(r.returncode, 0, r.stderr)
        lock = yaml.safe_load((self.rig.rel / "dev.lock.yaml").read_text(encoding="utf-8"))
        pushed = lock["images"]["lims/api"]
        self.assertRegex(pushed, r"@sha256:[0-9a-f]{64}$")
        r = self.rig.run("deploy", "dev", "dev-1")
        self.assertEqual(r.returncode, 0, r.stderr)
        a = self.rig.text(self.rig.calls("ansible-playbook")[-1]).replace('"', "")
        self.assertIn("deploy_api_image=" + pushed, a, "deploy must use the digest push.sh locked")


# =============================================================== review round 1 (C1.T-24-review.md items 2-4)
def _seed(rig, env, rel_deployed=None):
    rig.put_lock(env, NEW)
    (rig.rel / ("%s.deployed.lock.yaml" % env)).write_text(lock_text(env, rel_deployed or OLD), encoding="utf-8", newline="\n")


class EnvLockTest(Base):
    """03-APP-FLOW s2.1: flock on <LIMS_DEPLOY_LOCK_DIR|/var/lock>/lims-deploy-<env>, wait <= 10 min, then fail.
    Needs fake flock (none on Git-for-Windows bash): proves the script asks for the lock and refuses when it is not granted."""
    stub = True

    def test_deploy_takes_a_per_env_lock_with_a_bounded_wait(self):
        self.rig.put_lock("dev", NEW)
        r = self.rig.run("deploy", "dev", "dev-1")
        self.assertEqual(r.returncode, 0, r.stderr)
        calls = self.rig.flock_calls()
        self.assertEqual(len(calls), 1, "exactly one flock per deploy: %r" % calls)
        a = calls[0]
        self.assertTrue(any(x in ("-w", "--wait", "--timeout") for x in a), "flock without a wait bound: %r" % a)
        n = int(a[[i for i, x in enumerate(a) if x in ("-w", "--wait", "--timeout")][0] + 1])
        self.assertTrue(0 < n <= 600, "second deploy waits <= 10 min, got %s s" % n)
        self.assertTrue((self.rig.locks / "lims-deploy-dev").is_file(), "lock file lims-deploy-dev not opened")
        self.assertEqual(sorted(p.name for p in self.rig.locks.iterdir()), ["lims-deploy-dev"], "lock must be per env")

    def test_held_lock_refuses_deploy_before_anything_runs(self):
        self.rig.put_lock("dev", NEW)
        r = self.rig.run("deploy", "dev", "dev-1", env={"FAKE_FLOCK_RC": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stderr, r"(?i)lock")
        self.assertEqual(self.rig.calls(), [], "ansible/smoke ran while another deploy held the env lock")
        self.assertFalse((self.rig.rel / "dev.deployed.lock.yaml").exists())

    def test_lock_is_taken_for_each_env_name(self):
        self.rig.put_lock("staging", NEW)
        self.assertEqual(self.rig.run("deploy", "staging", "v1.0.0-rc.1").returncode, 0)
        self.assertEqual([p.name for p in self.rig.locks.iterdir()], ["lims-deploy-staging"])

    def test_standalone_rollback_takes_the_lock_and_refuses_when_held(self):
        _seed(self.rig, "dev")
        shutil.copy(CI / "rollback.sh", self.rig.ci / "rollback.sh")  # real rollback.sh (LD-90e); smoke stays the stub
        r = self.rig.run("rollback", "dev")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len(self.rig.flock_calls()), 1)
        self.assertTrue((self.rig.locks / "lims-deploy-dev").is_file())
        self.rig.log.write_text("", encoding="utf-8")
        before = list(self.rig.tf.glob("*.prom"))[0].read_text(encoding="utf-8")
        r = self.rig.run("rollback", "dev", env={"FAKE_FLOCK_RC": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls("ansible-playbook"), [], "rollback raced a running deploy")
        self.assertEqual(list(self.rig.tf.glob("*.prom"))[0].read_text(encoding="utf-8"), before, "counter moved without a rollback")

    def test_rollback_called_by_deploy_does_not_take_the_lock_again(self):  # would deadlock on a second open of the same file
        _seed(self.rig, "dev")
        shutil.copy(CI / "rollback.sh", self.rig.ci / "rollback.sh")  # the REAL rollback; smoke stays the stub
        r = self.rig.run("deploy", "dev", "dev-1", env={"SMOKE_RC": "1"})
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertEqual(self.rig.names(), ["ansible-playbook", "smoke.sh", "ansible-playbook"], "rollback must redeploy the old digests")
        self.assertEqual(len(self.rig.flock_calls()), 1, "deploy.sh holds the lock; rollback.sh it calls must reuse it")
        self.assertTrue(list(self.rig.tf.glob("*.prom")), "rollback did not finish (counter missing)")


class RollingFailureTest(Base):
    """03-APP-FLOW s2.1 line 100: health timeout during the rolling update -> rolling_back; errors BEFORE it -> failed (no rollback).
    Seam: deploy.sh passes `-e deploy_roll_marker=<RELEASES_DIR>/.<env>.rolling` and removes that file first; deploy.yml touches it
    right before the first roll task; the fake ansible-playbook touches it when FAKE_TOUCH_MARKER=1."""
    stub = True
    ENVS = (("prod", "v1.0.0", {"LIMS_APPROVED_RELEASE": "v1.0.0"}), ("staging", "v1.0.0-rc.1", {}), ("dev", "dev-1", {}))

    def test_marker_path_is_passed_and_a_stale_marker_is_removed_first(self):
        for env, rel, extra in self.ENVS:
            self.rig.log.write_text("", encoding="utf-8")
            self.rig.put_lock(env, NEW)
            marker = self.rig.rel / (".%s.rolling" % env)
            marker.write_text("stale", encoding="utf-8")
            r = self.rig.run("deploy", env, rel, env=dict(extra))
            self.assertEqual(r.returncode, 0, env + r.stderr)
            a = [x for x in self.rig.calls("ansible-playbook")[0]["args"] if x.startswith("deploy_roll_marker=")]
            self.assertEqual(len(a), 1, env + ": -e deploy_roll_marker=<path> missing")
            self.assertTrue(a[0].endswith("/.%s.rolling" % env), a[0])
            self.assertFalse(marker.exists(), env + ": stale marker survived into a new deploy (it would trigger a false rollback)")

    def test_failure_after_the_roll_started_rolls_back_and_fails(self):
        for env, rel, extra in self.ENVS:
            self.rig.log.write_text("", encoding="utf-8")
            _seed(self.rig, env)
            r = self.rig.run("deploy", env, rel, env=dict(extra, FAKE_ANSIBLE_RC="2", FAKE_TOUCH_MARKER="1"))
            self.assertEqual(r.returncode, 1, env + r.stderr)
            self.assertRegex(r.stderr, r"(?i)rolling back")
            self.assertEqual(self.rig.names(), ["ansible-playbook", "rollback.sh"], env + ": mixed release left in place")
            self.assertEqual(self.rig.calls("rollback.sh")[0]["args"], [env])
            kg = yaml.safe_load((self.rig.rel / ("%s.deployed.lock.yaml" % env)).read_text(encoding="utf-8"))["images"]
            self.assertEqual(kg, {"lims/%s" % n: OLD[n] for n in NAMES}, env + ": known-good lock must stay the OLD digests")

    def test_failure_before_the_roll_does_not_roll_back(self):
        for env, rel, extra in self.ENVS:
            self.rig.log.write_text("", encoding="utf-8")
            _seed(self.rig, env)
            (self.rig.rel / (".%s.rolling" % env)).write_text("stale", encoding="utf-8")
            r = self.rig.run("deploy", env, rel, env=dict(extra, FAKE_ANSIBLE_RC="2"))
            self.assertNotEqual(r.returncode, 0, env)
            self.assertEqual(self.rig.names(), ["ansible-playbook"], env + ": rollback/smoke after a pre-roll failure")

    def test_failed_rollback_after_a_roll_failure_is_still_nonzero(self):
        _seed(self.rig, "dev")
        r = self.rig.run("deploy", "dev", "dev-1", env={"FAKE_ANSIBLE_RC": "2", "FAKE_TOUCH_MARKER": "1", "ROLLBACK_RC": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.names(), ["ansible-playbook", "rollback.sh"])


class ProdKeyTest(Base):
    """02-TRD s12.2: the runner holds no prod key; lims-prod-decrypt@<release> releases it (default /run/lims/ci-prod/age.key,
    seam LIMS_PROD_KEY_FILE) and deploy/rollback hand it to ansible-playbook as SOPS_AGE_KEY_FILE for prod ONLY."""
    stub = True
    NOKEY = {"LIMS_PROD_KEY_FILE": "/nonexistent/lims-ci-prod/age.key"}

    def test_prod_deploy_without_a_released_key_is_refused_before_ansible(self):
        _seed(self.rig, "prod")
        r = self.rig.run("deploy", "prod", "v1.0.0", env=dict(self.NOKEY, LIMS_APPROVED_RELEASE="v1.0.0"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("lims-prod-decrypt@v1.0.0", r.stderr, "message must say which unit to start")
        self.assertEqual(self.rig.calls(), [], "ansible/smoke/rollback ran without the prod key")

    def test_prod_deploy_hands_the_released_key_to_ansible(self):
        self.rig.put_lock("prod", NEW)
        r = self.rig.run("deploy", "prod", "v1.0.0", env={"LIMS_APPROVED_RELEASE": "v1.0.0"})
        self.assertEqual(r.returncode, 0, r.stderr)
        keys = self.rig.sops_keys()
        self.assertEqual(len(keys), 1)
        self.assertEqual(Path(keys[0]).name, self.rig.key.name, "SOPS_AGE_KEY_FILE must point at the released key: %r" % keys)

    def test_prod_key_never_reaches_dev_or_staging(self):  # AC-21.1 / A9
        for env, rel in (("dev", "dev-1"), ("staging", "v1.0.0-rc.1")):
            self.rig.put_lock(env, NEW)
            r = self.rig.run("deploy", env, rel, env=dict(self.NOKEY))
            self.assertEqual(r.returncode, 0, "%s must not need the prod key: %s" % (env, r.stderr))
        r = self.rig.run("deploy", "dev", "dev-2")  # key file present on the box, still not used below prod
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.rig.sops_keys(), ["UNSET"] * 3, "prod key leaked into a non-prod ansible run")

    def test_prod_rollback_needs_and_uses_the_released_key(self):
        _seed(self.rig, "prod")
        shutil.copy(CI / "rollback.sh", self.rig.ci / "rollback.sh")  # real rollback.sh (LD-90e); smoke stays the stub
        r = self.rig.run("rollback", "prod", env=dict(self.NOKEY))
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.rig.calls("ansible-playbook"), [])
        self.assertEqual(list(self.rig.tf.glob("*.prom")), [], "counter moved without a rollback")
        self.assertNotIn("lims-prod-decrypt@rollback", r.stderr, "`rollback` is not a release id; there is no such instance")
        r = self.rig.run("rollback", "prod")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual([Path(k).name for k in self.rig.sops_keys()], [self.rig.key.name])


# =============================================================== deploy.yml (app part)
SERVICE_ORDER = ["api-a", "api-b", "worker-a", "worker-b", "web-a", "web-b", "portal", "renderer", "pdf-sandbox"]
SVC_RX = re.compile(r"(?<![\w-])(%s)(?![\w-])" % "|".join(SERVICE_ORDER))


def pctx(env, profile):
    c = t08.ctx(env=env, profile=profile)
    c["topology_profile"] = "full" if profile == "full" else "lean"
    return c


class DeployPlaybookTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plays = t08.load(DEPLOY)
        cls.items = t08.items_of(cls.plays)
        cls.text = DEPLOY.read_text(encoding="utf-8")

    def find(self, rx, field="name"):
        return [i for i in self.items if re.search(rx, str(i["task"].get(field, "")), re.I)]

    def mig(self):
        m = [i for i in self.items if "pnpm db:migrate" in t08.cmd_of(i["task"])]
        self.assertTrue(m, "migration task missing")
        return m[0]

    def seeds(self):
        s = [i for i in self.items if "pnpm db:seed" in t08.cmd_of(i["task"])]
        self.assertTrue(s, "seed task missing")
        return s[-1]

    def test_all_tasks_inline_and_named(self):
        for i in self.items:
            self.assertNotIn(t08.short(t08.module_of(i["task"])), ("include_tasks", "import_tasks", "include_role", "import_role"))
            self.assertTrue(i["task"].get("name"), "unnamed task: " + t08.blob(i["task"])[:80])

    def test_no_literal_host_names(self):  # LD-45
        body = t08.strip_comments(self.text)
        self.assertIsNone(t08.HOSTNAME_RE.search(body), t08.HOSTNAME_RE.search(body))
        self.assertNotIn("10.79.", body)

    def test_pre_deploy_backup_prod_only_before_migrations_and_fatal(self):  # AC-20.2, 02-TRD 7.9 step 2
        bk = [i for i in self.items if "pgbackrest" in t08.cmd_of(i["task"]) and re.search(r"\bbackup\b", t08.cmd_of(i["task"]))]
        self.assertEqual(len(bk), 1, "exactly one pgbackrest backup task required in deploy.yml")
        b = bk[0]
        cmd = t08.cmd_of(b["task"])
        self.assertIn("--type=incr", cmd)
        self.assertIn("--repo=1", cmd)
        self.assertLess(b["idx"], self.mig()["idx"], "backup must precede migrations")
        for profile in ("full", "lean", "dev"):
            self.assertTrue(t08.rendered_cmds(b, pctx("prod", profile)), "backup must run in prod (%s)" % profile)
            for env in ("staging", "dev"):
                self.assertFalse(t08.rendered_cmds(b, pctx(env, profile)), "backup is prod only (%s/%s)" % (env, profile))
        t = b["task"]
        self.assertFalse(t.get("ignore_errors"), "a failed backup must stop the deploy")
        self.assertNotIn("failed_when: false", self.text)
        on_data = str(b["play"]["hosts"]).strip() == "data" or "data" in str(t.get("delegate_to", ""))
        self.assertTrue(on_data, "pgbackrest runs on the data group (db host), not the app/ops group")
        self.assertTrue(b["play"].get("any_errors_fatal") is True, "backup play must be any_errors_fatal (full profile: app host would continue)")

    def test_images_are_digest_checked_for_every_service(self):
        pre = [i for i in self.items if t08.short(t08.module_of(i["task"])) == "assert" and "deploy_api_image" in t08.blob(i["task"])]
        self.assertTrue(pre, "preconditions assert missing")
        blob = t08.blob(pre[0]["task"])
        for n in NAMES:
            self.assertIn("deploy_%s_image" % n.replace("-", "_"), blob, "digest precondition missing for " + n)
        self.assertGreaterEqual(blob.count("@sha256"), 6)

    def test_rolling_update_order_per_profile(self):  # 02-TRD 12.3 step 5, LD-45
        seeds = self.seeds()["idx"]
        roll = [i for i in self.items if i["idx"] > seeds]
        self.assertTrue(roll, "no app roll tasks after the seeds")
        for profile in ("full", "lean", "dev"):
            seq = []
            for i in roll:
                for cmd in t08.rendered_cmds(i, pctx("staging", profile)):
                    if re.search(r"docker compose", cmd) and re.search(r"\bup\b", cmd):
                        seq += SVC_RX.findall(cmd)
            want = SERVICE_ORDER if profile == "full" else [s for s in SERVICE_ORDER if s not in ("worker-b", "web-b")]
            self.assertEqual(seq, want, "profile %s: rolling order/set" % profile)

    @staticmethod
    def _envs(item):
        return [json.dumps(s["environment"], default=str) for s in list(item["parents"]) + [item["task"]] if "environment" in s]

    def test_every_compose_task_carries_the_whole_compose_env(self):  # review item 1: compose interpolates the WHOLE file (${X:?})
        seen = 0
        for i in self.items:
            if "docker compose" in t08.cmd_of(i["task"]):
                seen += 1
                self.assertTrue(any("deploy_compose_env" in e for e in self._envs(i)),
                                "`docker compose` task without deploy_compose_env in its environment: %s" % i["task"].get("name"))
        self.assertGreaterEqual(seen, 12, "migrate x3 + 9 roll tasks expected")
        mig = self.mig()
        e = " ".join(self._envs(mig))
        self.assertIn("PGPASSWORD", e)
        self.assertIn("deploy_migrator_secret", e, "migrator credential must still reach the migrate tasks")
        self.assertNotRegex(t08.cmd_of(mig["task"]), r"(?i)PGPASSWORD=\S")

    def test_every_roll_waits_five_minutes_for_health(self):  # review item 3a: 5 min [CONV]
        rolls = [i for i in self.items if re.search(r"docker compose[^\n]*\bup\b", t08.cmd_of(i["task"]))]
        self.assertGreaterEqual(len(rolls), 9)
        for i in rolls:
            self.assertRegex(t08.cmd_of(i["task"]), r"--wait\b[^\n]*--wait-timeout\s+300\b|--wait-timeout\s+300\b[^\n]*--wait\b", i["task"].get("name"))

    def test_roll_marker_is_touched_once_right_before_the_first_roll(self):  # review item 3b
        mk = [i for i in self.items if "deploy_roll_marker" in t08.blob(i["task"])]
        self.assertEqual(len(mk), 1, "exactly one task may reference deploy_roll_marker")
        m = mk[0]
        t = m["task"]
        self.assertEqual(t08.short(t08.module_of(t)), "file")
        body = t[t08.module_of(t)]
        self.assertEqual(body.get("state"), "touch")
        self.assertIn("deploy_roll_marker", str(body.get("path")))
        self.assertEqual(t.get("delegate_to"), "localhost")
        self.assertIs(t.get("run_once"), True)
        first_roll = min(i["idx"] for i in self.items if re.search(r"docker compose[^\n]*\bup\b", t08.cmd_of(i["task"])))
        self.assertLess(m["idx"], first_roll)
        self.assertGreater(m["idx"], self.seeds()["idx"], "a migration/seed failure is a pre-roll error: no rollback")
        between = [i for i in self.items if m["idx"] < i["idx"] < first_roll]
        self.assertEqual(between, [], "marker must be the last task before Roll api-a")
        c = pctx("dev", "lean")
        self.assertFalse(t08.active(m, c), "task must be skipped when deploy_roll_marker is not passed")
        c["deploy_roll_marker"] = "/x/.dev.rolling"
        self.assertTrue(t08.active(m, c))

    def test_roll_uses_digest_images_and_no_latest(self):
        for v in ("LIMS_API_IMAGE", "LIMS_WORKER_IMAGE", "LIMS_WEB_IMAGE", "LIMS_PORTAL_IMAGE", "LIMS_RENDERER_IMAGE", "LIMS_PDF_SANDBOX_IMAGE"):
            self.assertIn(v, self.text, v)
        self.assertNotRegex(t08.strip_comments(self.text), r":latest\b")

    def test_readiness_between_api_a_and_api_b(self):
        idx = {}
        for i in self.items:
            for cmd in t08.rendered_cmds(i, pctx("dev", "lean")):
                for s in SVC_RX.findall(cmd):
                    idx.setdefault(s, i)
        self.assertIn("api-a", idx, "no rolling `docker compose up` task for api-a")
        self.assertIn("api-b", idx, "no rolling `docker compose up` task for api-b")
        a, b = idx["api-a"], idx["api-b"]
        waits = [i for i in self.items if a["idx"] <= i["idx"] < b["idx"]
                 and (re.search(r"--wait|healthy|health", t08.blob(i["task"]), re.I) or any(k in i["task"] for k in ("until", "retries")) or t08.short(t08.module_of(i["task"])) == "wait_for")]
        self.assertTrue(waits, "api-a must be healthy before api-b is touched (no wait/health task between them)")

    def test_mail_sink_guard_for_non_prod(self):  # AC-21.2
        g = [i for i in self.items if t08.short(t08.module_of(i["task"])) in ("assert", "fail") and "mail_sink_fqdn" in t08.blob(i["task"])]
        self.assertTrue(g, "no assert/fail on mail_sink_fqdn in deploy.yml")
        t = g[0]["task"]
        mod = t08.short(t08.module_of(t))

        def passes(env, relay, sink="sink.lims.internal"):
            c = pctx(env, "lean")
            c.update(smtp_relay_fqdn=relay, mail_sink_fqdn=sink)
            if not t08.active(g[0], c):
                return True  # task skipped for this env
            body = t[t08.module_of(t)]
            if mod == "assert":
                that = body["that"] if isinstance(body["that"], list) else [body["that"]]
                return all(t08.ev(x, c) for x in that)
            return False

        self.assertTrue(passes("dev", "sink.lims.internal"))
        self.assertTrue(passes("staging", "sink.lims.internal"))
        self.assertFalse(passes("dev", "smtp.relay.example"), "dev pointing at a real relay must fail the deploy")
        self.assertFalse(passes("staging", "smtp.relay.example"), "staging pointing at a real relay must fail the deploy")
        self.assertTrue(passes("prod", "smtp.relay.example"), "prod uses the real relay")
        self.assertLess(g[0]["idx"], self.mig()["idx"], "guard must run before anything changes")

    def test_seeds_stay_synthetic_outside_prod(self):  # AC-21.2 / CV 11.2
        s = self.seeds()
        for env, want_all in (("prod", False), ("staging", True), ("dev", True)):
            cmds = t08.rendered_cmds(s, pctx(env, "lean"))
            self.assertTrue(cmds)
            self.assertEqual("--all" in cmds[0] or "db/seeds/*" in cmds[0], want_all, env)

    def test_release_record_in_ops_audit(self):  # 02-TRD 12.3 step 8
        rec = [i for i in self.items if "deploy_ops_note" in t08.blob(i["task"]) and "release" in t08.blob(i["task"]).lower()
               and i["idx"] > self.seeds()["idx"]]
        self.assertTrue(rec, "no ops_audit release record after the roll")

    def test_no_secret_in_command_lines_or_logs(self):
        for i in self.items:
            cmd = t08.cmd_of(i["task"])
            self.assertNotRegex(cmd, r"(?i)(PGPASSWORD|password|secret)=\S", "secret on a command line: " + str(i["task"].get("name")))
            if "deploy_migrator_secret" in t08.blob(i["task"]) and "environment" not in i["task"]:
                self.assertTrue(i["task"].get("no_log") or "stdout" not in t08.blob(i["task"]), i["task"].get("name"))


# =============================================================== role ci_runner (07-SEC A9)
def role_files():
    if not ROLE.is_dir():
        raise AssertionError("missing role infra/ansible/roles/ci_runner")
    out = {}
    for p in sorted(ROLE.rglob("*")):
        if p.is_file() and p.suffix != ".pyc":
            try:
                out[p.relative_to(ROLE).as_posix()] = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                pass
    return out


class RunnerRoleTest(unittest.TestCase):
    def test_role_layout_and_defaults(self):
        f = role_files()
        self.assertIn("tasks/main.yml", f)
        self.assertIn("defaults/main.yml", f)
        d = yaml.safe_load(f["defaults/main.yml"])
        self.assertTrue(d.get("ci_runner_user"), "ci_runner_user default")
        self.assertNotIn(d["ci_runner_user"], ("root", "0"), "runner must not be root")
        self.assertIn("nepal-ops", str(d.get("ci_runner_labels")), "CR-C1-001 label")

    def test_site_yml_runs_it_on_ops_after_registry(self):
        plays = yaml.safe_load(SITE.read_text(encoding="utf-8"))
        flat = [(n, str(p.get("hosts")), r if isinstance(r, str) else r.get("role", r.get("name"))) for n, p in enumerate(plays) for r in p.get("roles", [])]
        mine = [x for x in flat if x[2] == "ci_runner"]
        self.assertTrue(mine, "role ci_runner not in site.yml")
        self.assertEqual(mine[0][1].strip(), "ops", "runner only on the ops group (lean: same host as everything)")
        reg = min(x[0] for x in flat if x[2] == "registry")
        self.assertGreater(mine[0][0], reg, "registry (server+client trust) first")

    def test_runner_service_unprivileged_and_prod_decrypt_service_separate(self):
        t = "\n".join(role_files().values())
        self.assertIn("lims-ci-runner.service", t)
        self.assertIn("lims-prod-decrypt.service", t)
        self.assertRegex(t, r"User\s*=\s*\{\{\s*ci_runner_user\s*\}\}", "runner unit runs as the unprivileged user")
        self.assertRegex(t, r"NoNewPrivileges\s*=\s*(true|yes)")
        self.assertRegex(t, r"(?i)release[_ -]?id|RELEASE_ID|%i|@", "decrypt service is invoked with the approved release id")

    def test_runner_owns_no_key_material(self):  # A9: runner holds no age key for prod
        for name, txt in role_files().items():
            self.assertNotRegex(txt, r"AGE-SECRET-KEY|PRIVATE KEY-----", name)
        try:
            tasks = yaml.safe_load(role_files()["tasks/main.yml"]) or []
        except yaml.YAMLError as e:  # noqa: BLE001
            self.fail("tasks/main.yml invalid: %s" % e)
        for i in t08.items_of([{"hosts": "ops", "tasks": tasks}]):
            b = t08.blob(i["task"])
            if re.search(r"(?i)\bage\b|keys\.txt|sops", b) and re.search(r"owner", b):
                self.assertNotIn("ci_runner_user", json.dumps(i["task"].get("owner", i["task"])), "runner-owned key file: " + str(i["task"].get("name")))
            self.assertNotRegex(json.dumps(i["task"]), r"SOPS_AGE_KEY(?!_FILE)\b.*ci_runner", i["task"].get("name"))

    def test_registration_token_not_logged_not_literal_and_no_pr_events(self):
        t = "\n".join(role_files().values())
        self.assertNotRegex(t, r"(?i)(token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_-]{20,}")
        reg = [i for i in t08.items_of([{"hosts": "ops", "tasks": yaml.safe_load(role_files()["tasks/main.yml"]) or []}])
               if re.search(r"(?i)token", t08.blob(i["task"]))]
        for i in reg:
            self.assertTrue(i["task"].get("no_log") is True, "task using a token needs no_log: " + str(i["task"].get("name")))
        self.assertNotIn("pull_request", t, "runner config must never mention PR events (it never runs PR code)")

    def test_no_literal_host_names(self):  # LD-45
        for name, txt in role_files().items():
            self.assertIsNone(t08.HOSTNAME_RE.search(t08.strip_comments(txt)), name)


if __name__ == "__main__":
    unittest.main()
