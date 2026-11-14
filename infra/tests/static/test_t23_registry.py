"""T-23 tests (tester role): Nepal registry, image mirroring, push by digest, release lock files.

Covers 02-TRD s12.2 (build/push/mirror/lock), s3.3 (registry TLS+htpasswd on ops-1 wg IP :5000), s8.2 (registry_htpasswd),
s3.1/05-SCHEMA (registry storage, last 20 releases), pki/README (T-23 must restart the registry on leaf re-issue),
AC-20.1 (partial: push by digest to the Nepal registry), 07-SEC rows A9 (digest pinning, mirror from upstream digests),
REQ-SEC-129/138, CR-C1-006 and "Product-host ... egress: non-listed hosts fail" (egress probe).
Done when (T-23): product hosts pull only from the Nepal registry (egress probe to a foreign registry fails).

NOT provable here (see .orchestra/notes/T-23-tests.md): a real registry answering pulls, real TLS verification, a real
`docker push` digest, and the live egress probe on a product host (infra/tests/internal/registry_egress.sh, deploy-time).
The probe SCRIPT itself is proven here with a faked `nc` (it must exit 1 when any foreign registry is reachable).

CONTRACTS where the TRD is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * Registry name is `registry.lims.internal:5000` (TRD s12.2). NOTE the TRD also writes `registry.lims.internal/...`
   (no port) in s7 and T-05 pins its DB image that way; the two spellings cannot both resolve - lead to rule (see notes).
 * Role `registry` (infra/ansible/roles/registry): tasks/main.yml, defaults/main.yml, handlers/main.yml, a compose
   template (*.j2, contains `services:`) rendered with groups, hostvars, wg_ip (= ops-1 IP), inventory_hostname, env and
   the role defaults. Server part only on `ops`; client part (CA into /etc/docker/certs.d/registry.lims.internal:5000/ca.crt
   and an /etc/hosts entry for registry.lims.internal -> ops-1 wg IP, built from hostvars) on data, app, dr, ops.
   site.yml lists role `registry` after `internal_ca`, with hosts covering ops and all product hosts.
 * Compose service configured by REGISTRY_* env vars: REGISTRY_HTTP_TLS_CERTIFICATE / _KEY (from /srv/lims/pki/registry,
   mounted read-only), REGISTRY_AUTH_HTPASSWD_PATH / _REALM, REGISTRY_STORAGE_DELETE_ENABLED=true; storage volume
   /srv/lims/registry; published only as `<wg_ip>:5000:5000` (or network_mode host + REGISTRY_HTTP_ADDR=<wg_ip>:5000).
 * defaults: registry_keep_releases: 20; role schedules/ships `registry garbage-collect` (retention 05-SCHEMA).
 * Cert re-issue: a role file that mentions `internal_ca_reissued` and restarts/recreates the registry.
 * internal_ca registry leaf SAN must also carry DNS:registry.lims.internal (clients dial the NAME, an IP-only SAN fails
   TLS verification). That file is T-18's; a failure here means the writer files a CR/edit, not that the test is wrong.
 * ci/release-lock.sh <env> <ref>...   ref = registry.lims.internal:5000/<repo>@sha256:<64 lowercase hex>.
   Env var RELEASES_DIR overrides the output dir (default infra/releases). Writes <RELEASES_DIR>/<env>.lock.yaml:
   `env: <env>` and `images:` mapping (key free, value = full ref). Same repo again replaces the old digest. Output is
   deterministic. All-or-nothing: any bad argument -> non-zero exit, nothing written or changed. Env in dev|staging|prod.
   Serialised with a lock (parallel runs must not lose updates).
 * ci/push.sh <env> <local-image>...   docker push to registry.lims.internal:5000/<repo>:<tag>; the digest is read from
   the `docker push` output line `digest: sha256:<hex>`; then release-lock.sh records it. Never pushes anywhere else
   (a local name with a foreign host prefix is rejected or re-targeted). Missing digest / failed push -> no lock write.
 * ci/push.sh mirror <upstream-ref>@sha256:<hex>   docker pull of exactly that ref, tag + push into the Nepal registry;
   a ref without a digest is refused BEFORE any docker call; if the pushed digest differs from the upstream one -> fail.
 * Only the `docker` CLI is used (no skopeo/crane in the tool register); tests fake it on PATH.
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t23_*.py" -v
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
ROLE = ROOT / "infra" / "ansible" / "roles" / "registry"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
PUSH = ROOT / "infra" / "ci" / "push.sh"
LOCK = ROOT / "infra" / "ci" / "release-lock.sh"
PROBE = ROOT / "infra" / "tests" / "internal" / "registry_egress.sh"
CA_DEFAULTS = ROOT / "infra" / "ansible" / "roles" / "internal_ca" / "defaults" / "main.yml"
DAEMON = ROOT / "infra" / "ansible" / "roles" / "docker_engine" / "files" / "daemon.json"
RELEASES = ROOT / "infra" / "releases"
SCHEMAS = ROOT / "infra" / "secrets" / "schema"

REG = "registry.lims.internal:5000"
OPS_IP = "10.79.0.14"
WG = {"data-1": "10.79.0.11", "app-1": "10.79.0.12", "dr-1": "10.79.0.13", "ops-1": OPS_IP}
FOREIGN = ["docker.io", "index.docker.io", "registry-1.docker.io", "ghcr.io", "quay.io", "gcr.io", "k8s.gcr.io",
           "registry.k8s.io", "public.ecr.aws", "mcr.microsoft.com"]
HEX = "0123456789abcdef"


def dg(c):
    return "sha256:" + c * 64


def ref(repo="lims/api", c="a"):
    return "%s/%s@%s" % (REG, repo, dg(c))


def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def _need(path):
    if not path.exists():
        raise AssertionError("missing file %s" % path.relative_to(ROOT).as_posix())
    return path


def _code(path):
    """Script text without comment lines."""
    return "\n".join(l for l in _need(path).read_text(encoding="utf-8").splitlines() if not l.lstrip().startswith("#"))


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


def _role_files():
    if not ROLE.exists():
        raise AssertionError("missing role infra/ansible/roles/registry")
    out = {}
    for p in sorted(ROLE.rglob("*")):
        if p.is_file() and p.suffix not in (".pyc",):
            try:
                out[p.relative_to(ROLE).as_posix()] = p.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                pass
    return out


def _role_text():
    return "\n".join(_role_files().values())


def _ctx(extra=None):
    groups = {"data": ["data-1"], "app": ["app-1"], "dr": ["dr-1"], "ops": ["ops-1"], "all": list(WG)}
    c = {"groups": groups, "hostvars": {h: {"wg_ip": ip} for h, ip in WG.items()}, "inventory_hostname": "ops-1",
         "wg_ip": OPS_IP, "env": "prod", "role_path": str(ROLE)}
    c.update(extra or {})
    return c


def _render_str(s, ctx):
    env = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
    return env.from_string(s).render(**ctx)


def _defaults():
    p = _need(ROLE / "defaults" / "main.yml")
    raw = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    ctx = _ctx()

    def walk(v):
        if isinstance(v, str):
            return _render_str(v, ctx)
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v
    return walk(raw)


def _compose():
    """Render the role's compose template(s); return (service dict for the registry, full services dict)."""
    tdir = ROLE / "templates"
    cands = [p for p in sorted(tdir.rglob("*.j2")) if "services:" in p.read_text(encoding="utf-8")] if tdir.exists() else []
    assert cands, "no compose template (*.j2 with `services:`) under roles/registry/templates"
    ctx = _ctx(_defaults())
    services = {}
    for p in cands:
        doc = yaml.safe_load(_render_str(p.read_text(encoding="utf-8"), ctx)) or {}
        services.update(doc.get("services") or {})
    for name, svc in services.items():
        if re.search(r"(^|/)(registry|distribution)(/distribution)?:", str(svc.get("image", ""))):
            return svc, services
    raise AssertionError("no service with a Distribution `registry:` image in %s" % [p.name for p in cands])


def _env_of(svc):
    e = svc.get("environment") or {}
    if isinstance(e, list):
        e = dict(x.split("=", 1) for x in e)
    return {str(k): str(v) for k, v in e.items()}


def _tasks_all():
    """Every task dict (blocks flattened) from tasks/*.yml and handlers/*.yml, parsed from the raw files."""
    out = []

    def walk(items):
        for t in items or []:
            if not isinstance(t, dict):
                continue
            out.append(t)
            for k in ("block", "rescue", "always"):
                walk(t.get(k))
    for sub in ("tasks", "handlers"):
        d = ROLE / sub
        assert d.exists(), "missing roles/registry/%s" % sub
        for p in sorted(d.glob("*.y*ml")):
            walk(yaml.safe_load(p.read_text(encoding="utf-8")))
    return out


def _site_plays():
    doc = yaml.safe_load(_need(SITE).read_text(encoding="utf-8"))
    plays = []
    for pl in doc:
        hosts = pl.get("hosts", "")
        hs = set(h for h in re.split(r"[:,]", ",".join(hosts) if isinstance(hosts, list) else str(hosts)) if h)
        roles = [(r if isinstance(r, str) else r.get("role") or r.get("name")) for r in pl.get("roles", []) or []]
        plays.append((hs, roles))
    return plays


# ============================================================ role: server side
class RegistryServerTest(unittest.TestCase):
    def test_role_files_exist(self):
        for rel in ("tasks/main.yml", "defaults/main.yml", "handlers/main.yml"):
            _need(ROLE / rel)
        _compose()

    def test_image_pinned_distribution_3(self):
        svc, _ = _compose()
        self.assertRegex(svc["image"], r"(^|/)(registry|distribution/distribution):3\.\d+\.\d+(@sha256:[0-9a-f]{64})?$",
                         "Distribution v3.x.y pinned (TRD s2: v3.1.2), never :latest/:2")

    def test_published_only_on_ops_wg_ip(self):
        svc, services = _compose()
        ports = [str(p) for p in svc.get("ports") or []]
        if ports:
            self.assertEqual(len(ports), 1, ports)
            self.assertRegex(ports[0], r"^%s:5000:5000(/tcp)?$" % re.escape(OPS_IP),
                             "explicit wg IP bind; bare 5000:5000 or 0.0.0.0 would expose it on the public NIC")
        else:
            self.assertEqual(svc.get("network_mode"), "host")
            self.assertTrue(_env_of(svc).get("REGISTRY_HTTP_ADDR", "").startswith(OPS_IP + ":5000"), _env_of(svc))
        for n, s in services.items():
            for p in s.get("ports") or []:
                self.assertNotRegex(str(p), r"^(0\.0\.0\.0:|:|\d+:\d+)", "%s publishes %s without a host IP" % (n, p))

    def test_tls_htpasswd_and_storage_wiring(self):
        svc, _ = _compose()
        e = _env_of(svc)
        for k in ("REGISTRY_HTTP_TLS_CERTIFICATE", "REGISTRY_HTTP_TLS_KEY", "REGISTRY_AUTH_HTPASSWD_PATH",
                  "REGISTRY_AUTH_HTPASSWD_REALM"):
            self.assertTrue(e.get(k), "env %s missing/empty" % k)
        self.assertEqual(e.get("REGISTRY_STORAGE_DELETE_ENABLED", "").lower(), "true", "needed for garbage-collect")
        self.assertNotIn(e.get("REGISTRY_AUTH", "htpasswd").lower(), ("none", "silly"), "anonymous pulls")
        vols = [str(v) for v in svc.get("volumes") or []]
        pki = [v for v in vols if v.startswith("/srv/lims/pki/registry")]
        self.assertTrue(pki and all(re.search(r":ro(\b|$)", v) for v in pki), "leaf key/cert mounted read-only: %s" % vols)
        self.assertTrue(any(v.startswith("/srv/lims/registry:") for v in vols), "storage on the LUKS data volume: %s" % vols)
        for k in ("REGISTRY_HTTP_TLS_CERTIFICATE", "REGISTRY_HTTP_TLS_KEY"):
            self.assertNotRegex(e[k], r"UNDEF_", e[k])

    def test_no_pull_through_cache(self):
        t = _role_text()
        self.assertNotRegex(t, r"(?i)REGISTRY_PROXY_REMOTEURL|remoteurl",
                            "a pull-through cache lets product hosts reach foreign registries via the Nepal one")

    def test_container_hardening(self):
        svc, _ = _compose()
        self.assertIs(svc.get("read_only"), True)
        self.assertIn("ALL", [str(c).upper() for c in svc.get("cap_drop") or []])
        self.assertNotIn(str(svc.get("user", "0")).split(":")[0], ("0", "root"), "must run non-root")
        self.assertFalse(svc.get("privileged"))
        self.assertFalse([v for v in svc.get("volumes") or [] if "docker.sock" in str(v)])
        self.assertNotIn("host", [svc.get("pid"), svc.get("ipc")])

    def test_htpasswd_task_no_log_and_not_world_readable(self):
        hits = [t for t in _tasks_all() if "registry_htpasswd" in yaml.safe_dump(t)]
        self.assertTrue(hits, "no task installs the secret id registry_htpasswd")
        for t in hits:
            self.assertIs(t.get("no_log"), True, "task %r handles the htpasswd secret" % t.get("name"))
            for v in t.values():
                if isinstance(v, dict) and "mode" in v:
                    self.assertRegex(str(v["mode"]).zfill(4), r"^0[0-7][0-7]0$", "mode %s gives 'other' access" % v["mode"])
        self.assertNotRegex(_role_text(), r"\$2[aby]\$\d\d\$", "bcrypt hash committed")

    def test_retention_and_garbage_collect(self):
        d = _defaults()
        self.assertEqual(d.get("registry_keep_releases"), 20, "05-SCHEMA: last 20 releases per image [CONV]")
        t = _role_text()
        self.assertIn("garbage-collect", t)
        self.assertIn("registry_keep_releases", yaml.safe_dump({k: v for k, v in _role_files().items() if not k.startswith("defaults")}))

    def test_restart_on_leaf_reissue(self):
        ok = [t for rel, t in _role_files().items() if rel.split("/")[0] in ("tasks", "handlers")
              and "internal_ca_reissued" in t and "registry" in t
              and re.search(r"restart|recreate|force_recreate|up -d", t)]
        self.assertTrue(ok, "pki/README: registry consumer must restart on `internal_ca_reissued`, else it serves the old cert")

    def test_server_part_only_on_ops(self):
        t = "\n".join(v for k, v in _role_files().items() if k.startswith("tasks/"))
        self.assertRegex(t, r"""inventory_hostname\s+in\s+groups\[['"]ops['"]\]|['"]ops['"]\s+in\s+group_names""",
                         "server tasks must be gated to ops (the role also runs on product hosts as a client)")

    def test_pulls_through_ops_proxy(self):
        t = _role_text() + "\n" + _code(PUSH)
        self.assertRegex(t, r"(?i)https?_proxy|squid|:3128|ops_proxy", "TRD s12.2: third-party images via the ops Squid proxy")


# ============================================================ role: client side + play + CA
class RegistryClientTest(unittest.TestCase):
    def test_client_trust_and_name(self):
        t = _role_text()
        self.assertIn("/etc/docker/certs.d/registry.lims.internal:5000", t)
        self.assertIn("ca.crt", t)
        self.assertIn("/etc/hosts", t)
        self.assertRegex(t, r"hostvars|groups\[['\"]ops['\"]\]", "ops-1 wg IP must come from the inventory, not a literal")
        self.assertNotRegex(t, r"(?i)insecure[-_]registr|skip[_-]?tls|tlsverify:\s*(false|no)", "TLS verification stays on")

    def test_site_plays_cover_ops_and_product_hosts_after_ca(self):
        plays = _site_plays()
        flat = [(i, r) for i, (_, roles) in enumerate(plays) for r in roles]
        reg = [i for i, r in flat if r == "registry"]
        self.assertTrue(reg, "role registry not used in playbooks/site.yml")
        hosts = set().union(*[plays[i][0] for i in reg])
        self.assertIn("ops", hosts)
        self.assertTrue("all" in hosts or {"data", "app", "dr"} <= hosts, "product hosts need the client part: %s" % hosts)
        ca_pos = min((n for n, (i, r) in enumerate(flat) if r == "internal_ca"), default=None)
        reg_pos = min(n for n, (i, r) in enumerate(flat) if r == "registry")
        self.assertIsNotNone(ca_pos)
        self.assertLess(ca_pos, reg_pos, "internal_ca issues the registry leaf; it must run first")

    def test_registry_leaf_san_has_dns_name(self):
        t = _need(CA_DEFAULTS).read_text(encoding="utf-8")
        leaf = re.search(r"- name: registry\s*\n\s*san:\s*(.+)", t)
        self.assertTrue(leaf, "no registry leaf in internal_ca defaults")
        self.assertIn("DNS:registry.lims.internal", leaf.group(1),
                      "clients dial registry.lims.internal; an IP-only SAN fails verification (T-18 file -> CR/edit)")

    def test_docker_daemon_has_no_foreign_or_insecure_registry(self):
        d = json.loads(_need(DAEMON).read_text(encoding="utf-8"))
        self.assertNotIn("insecure-registries", d)
        for m in d.get("registry-mirrors", []):
            self.assertIn("registry.lims.internal", m, "registry-mirrors must be the Nepal registry only")

    def test_registry_secret_declared_in_every_env(self):
        for f in sorted(SCHEMAS.glob("*.secrets.schema.yaml")):
            self.assertIn("id: registry_htpasswd", f.read_text(encoding="utf-8"), f.name)

    def test_committed_lock_files_are_clean(self):
        # vacuous until the first pipeline commits one; then every entry must be a Nepal-registry digest ref
        for p in sorted(RELEASES.glob("*.lock.yaml")) if RELEASES.exists() else []:
            doc = yaml.safe_load(p.read_text(encoding="utf-8"))
            self.assertEqual(doc["env"], p.name.split(".")[0])
            for v in doc["images"].values():
                self.assertRegex(v, r"^registry\.lims\.internal:5000/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$")
            self.assertNotRegex(p.read_text(encoding="utf-8"), r"(?i)password|token|secret|auth")


# ============================================================ scripts: static
class ScriptStaticTest(unittest.TestCase):
    def test_not_stubs_and_strict_mode(self):
        for p in (PUSH, LOCK):
            t = _need(p).read_text(encoding="utf-8")
            self.assertNotIn("not implemented yet", t, p.name)
            self.assertRegex(t, r"set -[a-z]*e[a-z]*u[a-z]*o pipefail|set -euo pipefail", p.name)

    def test_only_nepal_registry_named(self):
        for p in (PUSH, LOCK):
            c = _code(p)
            self.assertIn(REG, c, p.name)
            for f in FOREIGN:
                self.assertNotRegex(c, r"(?<![\w.-])%s(?![\w-])" % re.escape(f), "%s names foreign registry %s" % (p.name, f))
            self.assertNotRegex(c, r":latest\b", "%s: tags float; digests pin" % p.name)

    def test_push_uses_lock_script_and_safe_login(self):
        c = _code(PUSH)
        self.assertIn("release-lock.sh", c)
        self.assertNotRegex(c, r"docker login[^\n]*(\s-p\b|--password(\s|=))", "password on the command line leaks via ps")
        self.assertNotRegex(c, r"(curl|wget)[^\n]*\|\s*(ba)?sh")
        self.assertNotRegex(c, r"\beval\b")


# ============================================================ release-lock.sh behaviour
class ReleaseLockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t23lock"))
        self.out = self.tmp / "rel"
        self.out.mkdir()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def run_lock(self, *args, extra_env=None):
        env = dict(os.environ, RELEASES_DIR=self.out.as_posix(), **(extra_env or {}))
        r = subprocess.run([_bash(), LOCK.as_posix(), *args], env=env, capture_output=True, text=True, timeout=60,
                           cwd=ROOT.as_posix())
        self.assertNotIn("not implemented", r.stderr, "still the T-01 stub")
        return r

    def snapshot(self):
        return {p.name: p.read_bytes() for p in sorted(self.out.iterdir())}

    def lock(self, env="dev"):
        return yaml.safe_load((self.out / ("%s.lock.yaml" % env)).read_text(encoding="utf-8"))

    def test_writes_lock_file(self):
        r = self.run_lock("dev", ref("lims/api", "a"), ref("lims/web", "b"))
        self.assertEqual(r.returncode, 0, r.stderr)
        d = self.lock("dev")
        self.assertEqual(d["env"], "dev")
        self.assertEqual(sorted(d["images"].values()), sorted([ref("lims/api", "a"), ref("lims/web", "b")]))
        self.assertEqual(list(self.snapshot()), ["dev.lock.yaml"], "no temp files left behind")

    def test_same_repo_replaces_digest_other_repos_kept(self):
        self.run_lock("dev", ref("lims/api", "a"), ref("lims/web", "b"))
        r = self.run_lock("dev", ref("lims/api", "c"))
        self.assertEqual(r.returncode, 0, r.stderr)
        vals = sorted(self.lock("dev")["images"].values())
        self.assertEqual(vals, sorted([ref("lims/api", "c"), ref("lims/web", "b")]))

    def test_deterministic_and_order_independent(self):
        self.run_lock("staging", ref("lims/api", "a"), ref("lims/web", "b"), ref("lims/worker", "c"))
        first = self.snapshot()
        self.run_lock("staging", ref("lims/worker", "c"), ref("lims/api", "a"), ref("lims/web", "b"))
        self.assertEqual(first, self.snapshot(), "reordering inputs must not change the file (git diff noise)")

    def test_envs_are_separate_files(self):
        self.run_lock("dev", ref("lims/api", "a"))
        self.run_lock("prod", ref("lims/api", "b"))
        self.assertEqual(sorted(self.snapshot()), ["dev.lock.yaml", "prod.lock.yaml"])
        self.assertEqual(list(self.lock("dev")["images"].values()), [ref("lims/api", "a")])

    def test_no_secret_material_in_file(self):
        self.run_lock("dev", ref("lims/api", "a"))
        t = (self.out / "dev.lock.yaml").read_text(encoding="utf-8")
        self.assertNotRegex(t, r"(?i)password|token|secret|auth|htpasswd")

    def test_rejections_change_nothing(self):
        self.run_lock("dev", ref("lims/api", "a"))
        before = self.snapshot()
        good = ref("lims/web", "b")
        bad = {
            "unknown env": ("qa", good),
            "env traversal": ("../x", good),
            "env with slash": ("dev/../prod", good),
            "empty env": ("", good),
            "no images": ("dev",),
            "tag only": ("dev", "%s/lims/web:1.2.3" % REG),
            "latest": ("dev", "%s/lims/web:latest" % REG),
            "short digest": ("dev", "%s/lims/web@sha256:%s" % (REG, "a" * 63)),
            "long digest": ("dev", "%s/lims/web@sha256:%s" % (REG, "a" * 65)),
            "upper-case digest": ("dev", "%s/lims/web@sha256:%s" % (REG, "A" * 64)),
            "non-hex digest": ("dev", "%s/lims/web@sha256:%s" % (REG, "g" * 64)),
            "sha512": ("dev", "%s/lims/web@sha512:%s" % (REG, "a" * 64)),
            "docker hub": ("dev", "docker.io/library/nginx@%s" % dg("a")),
            "implicit hub": ("dev", "nginx@%s" % dg("a")),
            "ghcr": ("dev", "ghcr.io/x/y@%s" % dg("a")),
            "lookalike host suffix": ("dev", "registry.lims.internal.evil.example:5000/lims/web@%s" % dg("a")),
            "lookalike host port": ("dev", "registry.lims.internal:50000/lims/web@%s" % dg("a")),
            "userinfo": ("dev", "user:pw@%s/lims/web@%s" % (REG, dg("a"))),
            "good + bad (all-or-nothing)": ("dev", good, "%s/lims/x:tag" % REG),
            "newline injection": ("dev", "%s/lims/web@%s\nevil: yes" % (REG, dg("a"))),
            "yaml injection": ("dev", "%s/lims/web\" , x: \"@%s" % (REG, dg("a"))),
            "repo traversal": ("dev", "%s/../../etc@%s" % (REG, dg("a"))),
            "upper-case repo": ("dev", "%s/Lims/Web@%s" % (REG, dg("a"))),
            "option-like": ("dev", "--help"),
        }
        for name, args in bad.items():
            with self.subTest(name):
                r = self.run_lock(*args)
                self.assertNotEqual(r.returncode, 0, "accepted: %s" % name)
                self.assertTrue(r.stderr.strip(), "silent failure")
                self.assertEqual(before, self.snapshot(), "file changed/created by a rejected call: %s" % name)

    def test_traversal_env_writes_nothing_outside(self):
        self.run_lock("../escape", ref("lims/api", "a"))
        self.assertFalse(list(self.tmp.glob("escape*")) or list(self.tmp.glob("*.lock.yaml")))

    def test_parallel_runs_do_not_lose_updates(self):
        for rnd in range(6):
            for p in self.out.iterdir():
                p.unlink()
            refs = [ref("lims/r%d" % i, HEX[i]) for i in range(4)]
            res = []
            ths = [threading.Thread(target=lambda r=r: res.append(self.run_lock("dev", r).returncode)) for r in refs]
            [t.start() for t in ths]
            [t.join() for t in ths]
            self.assertEqual(res, [0] * 4, "round %d" % rnd)
            self.assertEqual(sorted(self.lock("dev")["images"].values()), sorted(refs), "lost update in round %d" % rnd)


# ============================================================ push.sh behaviour (fake docker)
FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  push)
    [ "${FAKE_PUSH_FAIL:-}" = 1 ] && { echo "denied: requested access to the resource is denied" >&2; exit 1; }
    echo "The push refers to repository [${2%%:*}]"
    [ "${FAKE_NO_DIGEST:-}" = 1 ] || echo "${2##*:}: digest: sha256:${FAKE_DIGEST} size: 1234"
    ;;
  login) cat >/dev/null ;;
esac
exit 0
"""


class PushShTest(unittest.TestCase):
    D = "d" * 64

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t23push"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_DOCKER, encoding="utf-8", newline="\n")
        self.log = self.tmp / "docker.log"
        self.out = self.tmp / "rel"
        self.out.mkdir()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def run_push(self, *args, digest=None, **extra):
        env = dict(os.environ, FAKE_LOG=self.log.as_posix(), FAKE_DIGEST=digest or self.D, RELEASES_DIR=self.out.as_posix(),
                   PATH=self.bin.as_posix() + os.pathsep + os.environ.get("PATH", ""), **extra)
        r = subprocess.run([_bash(), PUSH.as_posix(), *args], env=env, capture_output=True, text=True, timeout=60,
                           cwd=ROOT.as_posix())
        self.assertNotIn("not implemented", r.stderr, "still the T-01 stub")
        return r

    def calls(self):
        return self.log.read_text(encoding="utf-8").splitlines() if self.log.exists() else []

    def test_usage_without_args(self):
        r = self.run_push()
        self.assertNotEqual(r.returncode, 0)
        self.assertRegex(r.stderr.lower(), r"usage")
        self.assertEqual(self.calls(), [])

    def test_push_records_digest_and_targets_only_nepal_registry(self):
        r = self.run_push("dev", "lims-api:abc123", "lims-web:abc123")
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        pushes = [c.split()[1] for c in self.calls() if c.startswith("push ")]
        self.assertEqual(len(pushes), 2, self.calls())
        for t in pushes:
            self.assertTrue(t.startswith(REG + "/"), "pushed to %s" % t)
        vals = list(yaml.safe_load((self.out / "dev.lock.yaml").read_text(encoding="utf-8"))["images"].values())
        self.assertEqual(len(vals), 2)
        for v in vals:
            self.assertRegex(v, r"^registry\.lims\.internal:5000/[a-z0-9._/-]+@sha256:%s$" % self.D)

    def test_foreign_prefixed_local_name_never_pushed_abroad(self):
        r = self.run_push("dev", "ghcr.io/evil/app:1")
        for c in self.calls():
            if c.startswith(("push ", "tag ")):
                self.assertTrue(c.split()[-1].startswith(REG + "/"), "left the Nepal registry: %s" % c)
        if r.returncode != 0:
            self.assertFalse((self.out / "dev.lock.yaml").exists())

    def test_bad_env_or_option_like_image_rejected_before_docker(self):
        for args in (("qa", "lims-api:1"), ("../x", "lims-api:1"), ("dev", "--privileged"), ("dev",), ("dev", "a b:1")):
            with self.subTest(args):
                self.log.unlink(missing_ok=True)
                r = self.run_push(*args)
                self.assertNotEqual(r.returncode, 0, args)
                self.assertEqual([c for c in self.calls() if c.startswith("push ")], [], args)
                self.assertEqual(list(self.out.iterdir()), [])

    def test_failed_push_or_missing_digest_writes_no_lock(self):
        for extra in ({"FAKE_PUSH_FAIL": "1"}, {"FAKE_NO_DIGEST": "1"}):
            with self.subTest(extra):
                r = self.run_push("dev", "lims-api:1", **extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(list(self.out.iterdir()), [], "lock written for an image that is not in the registry")

    def test_mirror_without_digest_refused_before_any_docker_call(self):
        for r_ in ("nginx:1.30.6", "docker.io/library/nginx:latest", "nginx", "nginx@sha256:%s" % ("a" * 63),
                   "ghcr.io/x/y@sha256:%s" % ("A" * 64)):
            with self.subTest(r_):
                self.log.unlink(missing_ok=True)
                r = self.run_push("mirror", r_)
                self.assertNotEqual(r.returncode, 0)
                self.assertRegex(r.stderr.lower(), r"digest")
                self.assertEqual(self.calls(), [])

    def test_mirror_pulls_exact_digest_and_pushes_only_to_nepal_registry(self):
        up = "nginx@sha256:%s" % self.D
        r = self.run_push("mirror", up)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        calls = self.calls()
        self.assertTrue(any(c.startswith("pull ") and c.split()[-1] == up for c in calls), calls)
        for c in calls:
            if c.startswith(("push ", "tag ")):
                self.assertTrue(c.split()[-1].startswith(REG + "/"), "left the Nepal registry: %s" % c)
        self.assertTrue(any(c.startswith("push ") for c in calls), calls)

    def test_mirror_fails_if_pushed_digest_differs_from_upstream(self):
        r = self.run_push("mirror", "nginx@sha256:%s" % self.D, digest="e" * 64)
        self.assertNotEqual(r.returncode, 0, "mirror whose digest changed must not be accepted")


# ============================================================ registry GC retention (rendered script, fake docker)
class RegistryGcPinnedTest(unittest.TestCase):
    """Review T-23 #1: retention must never delete a tag whose digest is pinned in a releases/*.lock.yaml
    (02-TRD s12.3 step 1, AC-20.3 rollback). CONTRACT: the GC template (templates/*gc*.j2) takes the list var
    `registry_pinned_digests` and keeps pinned tags; the keep-N count applies to unpinned tags only."""

    N = 25

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t23gc"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text("#!/usr/bin/env bash\necho \"$*\" >> \"$FAKE_LOG\"\nexit 0\n", encoding="utf-8", newline="\n")
        self.log = self.tmp / "docker.log"
        self.store = self.tmp / "store"
        self.tags = self.store / "docker/registry/v2/repositories/lims/api/_manifests/tags"
        for i in range(self.N):  # t00 oldest ... t24 newest
            d = self.tags / ("t%02d" % i) / "current"
            d.mkdir(parents=True)
            digest = dg("f") if i == 0 else "sha256:%064x" % i  # t00 = pinned digest, others unique
            (d / "link").write_text(digest, encoding="utf-8", newline="")
            os.utime(self.tags / ("t%02d" % i), (1_700_000_000 + i * 100,) * 2)

    def run_gc(self, pinned):
        tpls = sorted((ROLE / "templates").glob("*gc*.j2")) if (ROLE / "templates").exists() else []
        self.assertTrue(tpls, "no GC template (templates/*gc*.j2) in roles/registry")
        ctx = _ctx(_defaults())
        ctx.update(registry_storage=self.store.as_posix(), registry_etc=(self.tmp / "etc").as_posix(),
                   registry_keep_releases=20, registry_pinned_digests=pinned)
        script = self.tmp / "gc.sh"
        script.write_text(_render_str(tpls[0].read_text(encoding="utf-8"), ctx), encoding="utf-8", newline="\n")
        env = dict(os.environ, FAKE_LOG=self.log.as_posix(), PATH=self.bin.as_posix() + os.pathsep + os.environ.get("PATH", ""))
        return subprocess.run([_bash(), script.as_posix()], env=env, capture_output=True, text=True, timeout=60)

    def left(self):
        return sorted(p.name for p in self.tags.iterdir())

    def test_pinned_old_tag_survives_and_20_unpinned_remain(self):
        pinned = dg("f")  # t00 is the oldest tag and pinned by a lock file
        r = self.run_gc([pinned])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        left = self.left()
        self.assertIn("t00", left, "pinned digest's tag was deleted by retention: %s" % left)
        self.assertEqual(left, ["t00"] + ["t%02d" % i for i in range(5, self.N)], "20 newest unpinned + the pinned one must remain")

    def test_no_pins_keeps_newest_20(self):
        r = self.run_gc([])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.left(), ["t%02d" % i for i in range(5, self.N)])

    def test_gc_still_runs_garbage_collect(self):
        self.run_gc([dg("f")])
        self.assertIn("garbage-collect", self.log.read_text(encoding="utf-8") if self.log.exists() else "")


# ============================================================ egress probe script (faked nc)
FAKE_NC = r"""#!/usr/bin/env bash
# nc -z -w 3 HOST PORT ; succeeds when "HOST:PORT" (or "*") is in $FAKE_REACH
h=${@: -2:1}; p=${@: -1}
case " $FAKE_REACH " in *" $h:$p "*|*" * "*) exit 0;; esac
exit 1
"""


class EgressProbeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="t23nc"))
        (self.tmp / "nc").write_text(FAKE_NC, encoding="utf-8", newline="\n")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def probe(self, reach, nc="nc"):
        env = dict(os.environ, FAKE_REACH=reach, NC=nc, PATH=self.tmp.as_posix() + os.pathsep + os.environ.get("PATH", ""))
        return subprocess.run([_bash(), _need(PROBE).as_posix()], env=env, capture_output=True, text=True, timeout=60)

    def test_passes_when_only_nepal_registry_reachable(self):
        r = self.probe("registry.lims.internal:5000")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("not ok", r.stdout)
        self.assertGreaterEqual(r.stdout.count("blocked "), 8)

    def test_fails_when_any_foreign_registry_reachable(self):
        for host in ("registry-1.docker.io", "ghcr.io", "quay.io", "1.1.1.1"):
            with self.subTest(host):
                r = self.probe("registry.lims.internal:5000 %s:443" % host)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertRegex(r.stdout, r"not ok.*%s" % re.escape(host))

    def test_fails_when_nepal_registry_unreachable(self):
        r = self.probe("")
        self.assertEqual(r.returncode, 1)
        self.assertRegex(r.stdout, r"not ok.*Nepal registry")

    def test_fails_when_probe_tool_missing(self):
        r = self.probe("registry.lims.internal:5000", nc="no-such-nc-tool")
        self.assertEqual(r.returncode, 1, "every 'must fail' would pass vacuously without the tool")


if __name__ == "__main__":
    unittest.main()
