"""T-14 tests (tester role): LIMS runtime compose (api/worker/web/portal, renderer + pdf-sandbox envelopes, Valkey, Squid),
DOCKER-USER worker IPs, egress allowlist, memory budget (Sum mem_limit <= 85 % host RAM).

Covers 02-TRD s3.1/s3.2/s5.5/s7.4/s7.5, 01-PRD AC-08.1/.2, AC-09.1-.3, AC-10.1, AC-11.1/.3, AC-30.1, AC-32.1,
07-SEC rows REQ-SEC-086/087/130 and AB-5/AB-6/AB-17/AB-18, 06-PLAN row T-14. LD-45: every host count/size is read from the
active profile (inventory), never hard-coded; `lean` and `full` must both pass.

NOT provable here (infra/tests/integration/test_t14_live.py, LIMS_T14_LIVE=1, needs docker + C0/C6 images):
real containers healthy, SIGKILL restart <= 10 s, SIGTERM drain, real DOCKER-USER/br_netfilter behaviour. ALERTS ValkeyDown /
QueueBacklog (AC-08.3, AC-11.3 second half) are T-18/T-21 files and already tested there.

CONTRACTS where the spec is silent (writer meets them or files a dispute; never silently diverges):
 * infra/compose/lims/compose.app.yml keeps `migrate` (T-08) and adds services api-a, api-b, worker-a, worker-b, web-a, web-b,
   portal, partner, renderer, pdf-sandbox, valkey, squid (clamd = T-22, not asserted). nginx (T-13) reaches `api-a:8080`,
   `api-b:8080`, `http://web:3000`, `http://portal:3000`, `http://partner:3000`: web-a/web-b carry network alias `web`.
 * Profiles: services without `profiles:` = `lean`. worker-b and web-b: `profiles: [full]`; partner: `profiles: [partner]`
   (lean budget has worker x1, web x1, partner 0). Role lims_runtime sets COMPOSE_PROFILES from `topology_profile`/`partner_enabled`.
 * Image: `${VAR:?msg}` (fail closed, digest supplied by deploy) or `@sha256:<64 hex>`; never :latest / bare tags.
 * mem_limit of api/worker/web/portal may be `${VAR:-default}` (inventory `mem_limit_gib` feeds VAR via role lims_runtime); its
   default must resolve and be <= 2 GiB. renderer/pdf-sandbox/valkey/squid are literals.
 * Secret files bind-mounted read-only from /run/lims/secrets/<service>/ (secrets_render layout); env file
   /run/lims/env/<service>.env on api-*/worker-* (LIMS_CORE_REDIS_URL is rendered there, 02-TRD s7.4).
 * worker-a/worker-b have FIXED ipv4_address on render_net (172.30.40.0/24, distinct, not .11) and role nftables default
   `nftables_render_worker_ips` lists exactly those (today it is [] -> the sandbox rule is not rendered).
 * infra/edge/egress-allowlist.yaml: `destinations:` list of {fqdn, port, via: squid|smtp|acme, owner, purpose, section_04_11,
   f01_status: approved|pending|refused}; fqdn is a DNS name or a `{{ inventory_var }}`; Squid gets approved entries only.
 * roles/egress_proxy/templates/squid.conf.j2 rendered with `egress_proxy_fqdns` (list of approved squid-hosted names).
 * roles/valkey/templates/*acl*: rendered with `valkey_lims_api_password`; stores a sha256 hash (`#<hex>`), never the clear text.
 * infra/tests/internal/container_hardening.py gains a mode (daemon-json mode must keep working, T-03):
     container_hardening.py --memory-budget --ram-gib N [--max-pct 85] CONFIG.json [CONFIG.json ...]
   CONFIG = `docker compose config --format json` of one compose project of the host. Sum = mem_limit x replicas
   (deploy.replicas) over every service. Exit 0 sum <= pct, 1 over budget or a service without mem_limit (named on stdout),
   2 usage/unreadable. mem_limit: int bytes or string b/k/m/g (compose accepts "512m", "1.5g").
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t14_*.py" -v
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
COMPOSE = Path(os.environ.get("LIMS_T14_COMPOSE") or INFRA / "compose" / "lims" / "compose.app.yml")  # env: tester self-check only
ALLOW = INFRA / "edge" / "egress-allowlist.yaml"
ROLES = INFRA / "ansible" / "roles"
SITE = INFRA / "ansible" / "playbooks" / "site.yml"
INV = INFRA / "ansible" / "inventories"
INTERNAL = INFRA / "tests" / "internal"
HARDENING = INTERNAL / "container_hardening.py"
GiB = 1024 ** 3


# ---------------------------------------------------------------- helpers
class _Loader(yaml.SafeLoader):
    """compose files may use !reset/!override (LD-42): pass the plain value through."""


def _pass(loader, node):
    if isinstance(node, yaml.ScalarNode):
        return loader.construct_scalar(node) if node.value not in ("", "null", "~") else None
    if isinstance(node, yaml.SequenceNode):
        return loader.construct_sequence(node, deep=True)
    return loader.construct_mapping(node, deep=True)


_Loader.add_constructor("!reset", _pass)
_Loader.add_constructor("!override", _pass)


class _Undef(jinja2.ChainableUndefined):
    def __str__(self):
        return "UNDEF_%s" % self._undefined_name

    __html__ = __str__


def _hash(value, algo="sha1"):
    import hashlib
    return hashlib.new(algo, str(value).encode()).hexdigest()


JENV = jinja2.Environment(undefined=_Undef, keep_trailing_newline=True)
JENV.filters["hash"] = _hash


def need(path):
    p = Path(path)
    if not p.is_file():
        raise AssertionError("missing file %s" % p.relative_to(ROOT).as_posix())
    return p.read_text(encoding="utf-8")


def rel(p):
    return Path(p).relative_to(ROOT).as_posix()


def compose():
    d = yaml.load(need(COMPOSE), Loader=_Loader)
    if not isinstance(d, dict) or not isinstance(d.get("services"), dict):
        raise AssertionError("compose.app.yml has no services mapping")
    return d


def svc(name):
    s = compose()["services"].get(name)
    if s is None:
        raise AssertionError("compose.app.yml: service %s missing" % name)
    return s


def interp(v):
    """${VAR:-default} -> default; ${VAR:?msg} / ${VAR} -> <VAR> (unresolved)."""
    if not isinstance(v, str):
        return v

    def sub(m):
        name, op, arg = m.group(1), m.group(2), m.group(3)
        return arg if op in (":-", "-") else "<%s>" % name
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?])([^}]*))?\}", sub, v)


def to_bytes(v):
    v = interp(v)
    if isinstance(v, (int, float)):
        return int(v)
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([kmg]?)b?\s*", str(v).lower())
    if not m:
        raise AssertionError("cannot read memory size %r" % (v,))
    return int(float(m.group(1)) * {"": 1, "k": 1024, "m": 1024 ** 2, "g": GiB}[m.group(2)])


def env_of(s):
    e = s.get("environment") or {}
    if isinstance(e, list):
        out = {}
        for item in e:
            k, _, v = str(item).partition("=")
            out[k] = v
        return out
    return {k: ("" if v is None else str(v)) for k, v in e.items()}


def nets_of(s):
    n = s.get("networks") or {}
    return set(n if not isinstance(n, dict) else n.keys())


def net_cfg(s, net):
    n = s.get("networks")
    return (n.get(net) or {}) if isinstance(n, dict) else {}


def tmpfs_of(s):
    t = s.get("tmpfs") or []
    t = [t] if isinstance(t, str) else t
    out = {x.split(":")[0]: x for x in t}
    for v in s.get("volumes") or []:
        if isinstance(v, dict) and v.get("type") == "tmpfs":
            out[v["target"]] = "size=%s" % (v.get("tmpfs") or {}).get("size", "")
    return out


def volumes_of(s):
    """-> list of (source, target, read_only) for non-tmpfs mounts."""
    out = []
    for v in s.get("volumes") or []:
        if isinstance(v, dict):
            if v.get("type") == "tmpfs":
                continue
            out.append((str(v.get("source", "")), str(v.get("target", "")), bool(v.get("read_only"))))
        else:
            parts = str(v).split(":")
            ro = parts[-1].split(",")[0] == "ro" or "ro" in parts[-1].split(",") if len(parts) >= 3 else False
            out.append((parts[0], parts[1] if len(parts) > 1 else "", ro))
    return out


def cmd_tokens(s):
    c = s.get("command")
    return shlex.split(c) if isinstance(c, str) else [str(x) for x in (c or [])]


def healthcheck_text(s):
    t = (s.get("healthcheck") or {}).get("test")
    return " ".join(t) if isinstance(t, list) else str(t or "")


def uid_of(s):
    return str(s.get("user", "")).split(":")[0]


API = ["api-a", "api-b"]
WORKERS = ["worker-a", "worker-b"]
WEBS = ["web-a", "web-b"]
FULL_ONLY = {"worker-b", "web-b"}
ALL = API + WORKERS + WEBS + ["portal", "partner", "renderer", "pdf-sandbox", "valkey", "squid"]
NETS = {
    **{n: {"edge_net", "app_net", "auth_net", "render_net", "db_net"} for n in API},
    **{n: {"app_net", "render_net", "db_net"} for n in WORKERS},
    **{n: {"edge_net", "app_net"} for n in WEBS + ["portal", "partner"]},
    "renderer": {"render_net"}, "pdf-sandbox": {"render_net"}, "valkey": {"app_net"}, "squid": {"app_net", "egress_net"},
}
SANDBOX_IP = "172.30.40.11"


# ---------------------------------------------------------------- compose: shape
class ComposeShape(unittest.TestCase):
    def test_services_present_and_migrate_kept(self):  # T-08 file must keep its service
        for n in ALL + ["migrate"]:
            svc(n)

    def test_profiles_lean_default_full_adds_second_replicas(self):  # LD-45 lean = worker x1, web x1, partner 0
        for n in ALL:
            want = ["full"] if n in FULL_ONLY else ["partner"] if n == "partner" else None
            self.assertEqual(svc(n).get("profiles"), want, "%s profiles" % n)

    def test_networks_per_service_exact(self):  # 02-TRD s7.4 table, s3.2
        for n, want in NETS.items():
            self.assertEqual(nets_of(svc(n)), want, "%s networks" % n)

    def test_networks_are_external_named(self):
        top = compose().get("networks") or {}
        for n in ("edge_net", "app_net", "auth_net", "render_net", "db_net", "egress_net"):
            self.assertTrue(top.get(n, {}).get("external"), "%s must be external (docker_engine role creates it)" % n)
            self.assertEqual(top[n].get("name"), n)

    def test_api_alias_on_app_net_and_web_alias_on_edge_net(self):  # nginx upstreams (T-13)
        for n in API:
            self.assertIn("api", net_cfg(svc(n), "app_net").get("aliases", []), n)
        for n in WEBS:
            self.assertIn("web", net_cfg(svc(n), "edge_net").get("aliases", []), n)

    def test_images_fail_closed_or_digest(self):  # no :latest / bare tags (release lock, T-23)
        for n in ALL:
            img = str(svc(n).get("image", ""))
            self.assertTrue(re.fullmatch(r"\$\{[A-Z][A-Z0-9_]*:\?[^}]*\}", img) or re.search(r"@sha256:[0-9a-f]{64}$", img),
                            "%s image %r must be ${VAR:?..} or @sha256" % (n, img))
        self.assertNotIn(":latest", COMPOSE.read_text(encoding="utf-8"))

    def test_restart_and_no_dangerous_options(self):  # REQ-SEC-130, AC-08.1
        text = need(COMPOSE)
        self.assertNotRegex(text, r"docker\.sock", "no docker.sock mounts")
        for n in ALL:
            s = svc(n)
            self.assertEqual(s.get("restart"), "unless-stopped", "%s restart" % n)
            for bad in ("privileged", "network_mode", "pid", "ipc", "userns_mode", "cap_add", "devices", "sysctls"):
                self.assertNotIn(bad, s, "%s must not set %s" % (n, bad))
            for o in s.get("security_opt") or []:
                self.assertNotRegex(str(o), r"unconfined", "%s: %s" % (n, o))

    def test_hardening_baseline_everywhere(self):  # REQ-SEC-130
        for n in ALL:
            s = svc(n)
            self.assertIs(s.get("read_only"), True, "%s read_only" % n)
            self.assertEqual([str(x).upper() for x in s.get("cap_drop") or []], ["ALL"], "%s cap_drop" % n)
            self.assertIn("no-new-privileges:true", s.get("security_opt") or [], "%s no-new-privileges" % n)
            self.assertTrue(s.get("pids_limit"), "%s pids_limit" % n)
            self.assertIn("/tmp", tmpfs_of(s), "%s needs tmpfs /tmp when read_only" % n)

    def test_mem_limit_everywhere_and_default_resolves(self):  # AC-30.1 needs a limit on every container
        for n in ALL:
            b = to_bytes(svc(n).get("mem_limit"))
            self.assertTrue(0 < b <= 2 * GiB, "%s mem_limit default %s" % (n, b))

    def test_published_ports_only_metrics_on_wg_ip(self):  # 02-TRD s3.3, AC-01.3
        want = {"api-a": "9464", "api-b": "9465", "worker-a": "9466", "worker-b": "9467"}
        for n in ALL:
            ports = svc(n).get("ports") or []
            if n not in want:
                self.assertEqual(ports, [], "%s must publish nothing" % n)
                continue
            self.assertEqual(len(ports), 1, n)
            p = ports[0]
            if isinstance(p, dict):
                host_ip, pub, tgt = p.get("host_ip"), str(p.get("published")), str(p.get("target"))
            else:
                protected = re.sub(r"\$\{[^}]*\}", lambda m: m.group(0).replace(":", "\0"), str(p))  # ${VAR:?msg} has colons
                parts = [x.replace("\0", ":") for x in protected.split(":")]
                self.assertEqual(len(parts), 3, "%s: use ip:published:target" % n)
                host_ip, pub, tgt = parts
            self.assertTrue(host_ip and host_ip not in ("0.0.0.0", "::", "127.0.0.1"),
                            "%s: bind the wg IP explicitly (ops-1 scrapes over wg0), got %r" % (n, host_ip))
            self.assertRegex(interp(host_ip), r"^(<[A-Za-z_]+>|\d+\.\d+\.\d+\.\d+)$")
            self.assertEqual((pub, tgt), (want[n], "9464"), n)

    def test_fixed_render_net_addresses(self):  # 02-TRD s3.2 / s5.5 rule 6
        self.assertEqual(net_cfg(svc("pdf-sandbox"), "render_net").get("ipv4_address"), SANDBOX_IP)
        ips = [net_cfg(svc(w), "render_net").get("ipv4_address") for w in WORKERS]
        for ip in ips:
            self.assertRegex(str(ip), r"^172\.30\.40\.\d+$")
            self.assertNotIn(ip, (SANDBOX_IP, "172.30.40.1", "172.30.40.0"))
        self.assertEqual(len(set(ips)), 2)

    def test_every_render_net_member_has_static_ip(self):  # review T-14 #2: no dynamic IPAM on render_net
        # A dynamic member could be handed a worker/sandbox address after redeploys and pass nft rule 6 (AC-10.1).
        owner = {"pdf-sandbox": SANDBOX_IP}
        taken = {SANDBOX_IP, *(net_cfg(svc(w), "render_net").get("ipv4_address") for w in WORKERS)}
        taken |= {"172.30.40.21", "172.30.40.22"}  # nftables_render_worker_ips defaults (lean/full)
        seen = {}
        for n in ALL:
            if "render_net" not in nets_of(svc(n)):
                continue
            ip = net_cfg(svc(n), "render_net").get("ipv4_address")
            self.assertRegex(str(ip), r"^172\.30\.40\.\d+$", "%s needs a fixed render_net ipv4_address" % n)
            self.assertNotIn(ip, seen, "%s duplicates %s" % (n, seen.get(ip)))
            seen[ip] = n
            if n not in owner and n not in WORKERS:
                self.assertNotIn(ip, taken, "%s must not use an allowed worker/sandbox address" % n)

    def test_worker_uses_worker_image_not_api_image(self):  # review T-14 #1: C0 builds services/worker separately
        for n in WORKERS:
            self.assertNotEqual(svc(n).get("image"), svc("api-a").get("image"), "%s runs the API image" % n)
            self.assertRegex(str(svc(n).get("image")), r"^\$\{LIMS_WORKER_IMAGE:\?", n)
        tasks = need(ROLES / "lims_runtime" / "tasks" / "main.yml")
        self.assertIn("'worker'", tasks, "precondition loop must require the worker image digest")
        self.assertRegex(tasks, r"'LIMS_WORKER_IMAGE':\s*lims_runtime_images\.worker")

    def test_nftables_default_worker_ips_match_compose(self):  # rule 6 "only from worker-a/b" must actually render
        d = yaml.safe_load(need(ROLES / "nftables" / "defaults" / "main.yml"))
        want = {net_cfg(svc(w), "render_net").get("ipv4_address") for w in WORKERS}
        self.assertEqual(set(d.get("nftables_render_worker_ips") or []), want)
        self.assertEqual(d.get("nftables_pdf_sandbox_ip"), SANDBOX_IP)


# ---------------------------------------------------------------- compose: api / worker / BFF
class ApiWorkerEnv(unittest.TestCase):
    COMMON = {
        "LIMS_CORE_RATELIMIT_BACKEND": "redis",                      # AC-11.3
        "LIMS_CORE_EGRESS_PROXY_URL": "http://squid:3128",           # AC-09.3, CR-C1-008
        "LIMS_CORE_SCANNER_URL": "tcp://clamd:3310",
        "LIMS_CORE_SCANNER_TIMEOUT_MS": "30000",
    }

    def test_common_env_on_api_and_worker(self):
        for n in API + WORKERS:
            e = env_of(svc(n))
            for k, v in self.COMMON.items():
                self.assertEqual(e.get(k), v, "%s %s" % (n, k))

    def test_redis_url_comes_from_env_file_never_inline(self):  # AC-11.3, secrets only on tmpfs
        for n in API + WORKERS:
            s = svc(n)
            self.assertNotIn("LIMS_CORE_REDIS_URL", env_of(s), "%s: value holds the password; env_file only" % n)
            ef = s.get("env_file")
            ef = [ef] if isinstance(ef, str) else [x if isinstance(x, str) else x.get("path") for x in ef or []]
            self.assertEqual(ef, ["/run/lims/env/%s.env" % n])
        self.assertNotRegex(need(COMPOSE), r"redis://[^\s\"']*:[^@\s\"']+@", "no inline credentials")

    def test_trusted_proxy_for_api(self):  # AC-32.1
        for n in API:
            e = env_of(svc(n))
            self.assertEqual(e.get("LIMS_CORE_TRUSTED_PROXY_CIDRS"), "172.30.10.10/32")
            self.assertEqual(e.get("LIMS_CORE_TRUSTED_PROXY_HOPS"), "1")

    def test_bff_key_files_listed_and_mounted_ro(self):  # 02-TRD s7.4, 08 P-45
        want = "/run/secrets/bff/staff_web,/run/secrets/bff/partner,/run/secrets/bff/portal"
        for n in API:
            s = svc(n)
            self.assertEqual(env_of(s).get("LIMS_CORE_BFF_KEY_FILES"), want, n)
            vols = volumes_of(s)
            for path in want.split(","):
                hit = [v for v in vols if path == v[1] or path.startswith(v[1].rstrip("/") + "/")]
                self.assertTrue(hit, "%s: %s not mounted" % (n, path))
                self.assertTrue(all(v[2] for v in hit), "%s: %s must be read-only" % (n, path))

    def test_secret_file_envs_point_at_mounts(self):
        need_keys = {
            "api": ["LIMS_CORE_STORAGE_KEY_FILE", "LIMS_PAYMENTS_KEK_FILE", "LIMS_REPORTING_OTP_HMAC_KEY_FILE",
                    "LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE"],
            "worker": ["LIMS_CORE_STORAGE_KEY_FILE", "LIMS_PAYMENTS_KEK_FILE", "LIMS_REPORTING_OTP_HMAC_KEY_FILE",
                       "LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE", "LIMS_REPORTING_RENDERER_TOKEN_FILE",
                       "LIMS_REPORTING_SANDBOX_TOKEN_FILE"],
        }
        for n in API + WORKERS:
            s = svc(n)
            e = env_of(s)
            for k in need_keys["api" if n in API else "worker"]:
                self.assertIn(k, e, "%s %s" % (n, k))
                v = e[k]
                self.assertTrue(any(v == t or v.startswith(t.rstrip("/") + "/") for _, t, _ in volumes_of(s)),
                                "%s: %s=%s is not under a bind mount" % (n, k, v))

    def test_sandbox_token_never_on_api(self):  # AC-10.1: API must not be able to talk to the sandbox
        for n in API:
            s = svc(n)
            self.assertNotIn("LIMS_REPORTING_SANDBOX_TOKEN_FILE", env_of(s))
            self.assertFalse([v for v in volumes_of(s) if "pdf_sandbox_inbound_token" in v[0] + v[1]], n)

    def test_secret_mounts_only_from_own_service_dir(self):  # 07-SEC: secrets visible to named consumers only
        for n in ALL:
            own = {n, re.sub(r"-[ab]$", "", n)}
            for src, tgt, ro in volumes_of(svc(n)):
                if src.startswith("/run/lims/secrets"):
                    self.assertTrue(any(src == "/run/lims/secrets/%s" % o or src.startswith("/run/lims/secrets/%s/" % o) for o in own),
                                    "%s mounts %s" % (n, src))
                    self.assertTrue(ro, "%s: %s must be :ro" % (n, src))
            ef = svc(n).get("env_file")
            if ef and n not in API + WORKERS:
                self.fail("%s must not load an env file (only api/worker carry the Redis URL)" % n)

    def test_worker_supervision(self):  # AC-08.1, AC-08.2, 02-TRD s7.4
        for n in WORKERS:
            s = svc(n)
            self.assertEqual(s.get("stop_grace_period"), "60s", n)
            self.assertEqual(s.get("restart"), "unless-stopped")
            self.assertEqual(env_of(s).get("LIMS_CORE_WORKER_CONCURRENCY"), "10")
            self.assertRegex(healthcheck_text(s), r"/health/live", n)
            self.assertNotIn("auth_net", nets_of(s))

    def test_worker_urls_and_db_via_network_only(self):  # C6 hand-off
        for n in WORKERS:
            e = env_of(svc(n))
            self.assertRegex(e.get("LIMS_REPORTING_RENDERER_URL", ""), r"^http://renderer:\d+")
            self.assertRegex(e.get("LIMS_REPORTING_SANDBOX_URL", ""), r"^http://pdf-sandbox:\d+")

    def test_api_health_and_web_health(self):
        for n in API:
            self.assertRegex(healthcheck_text(svc(n)), r"/v1/core/health/ready", n)
        for n in WEBS + ["portal", "partner"]:
            self.assertTrue(healthcheck_text(svc(n)), "%s healthcheck" % n)

    def test_no_proxy_vars_on_non_egress_services(self):
        for n in ["renderer", "pdf-sandbox", "valkey"] + WEBS + ["portal"]:
            for k in env_of(svc(n)):
                self.assertNotRegex(k, r"(?i)^(http_proxy|https_proxy|all_proxy|no_proxy)$", "%s: %s" % (n, k))


# ---------------------------------------------------------------- compose: renderer / sandbox
class RendererSandboxEnvelope(unittest.TestCase):
    def test_renderer_limits(self):  # AC-09.2, 02-TRD s7.4
        s = svc("renderer")
        self.assertEqual(to_bytes(s["mem_limit"]), int(1.5 * GiB))
        self.assertLessEqual(to_bytes(s["mem_limit"]), int(1.5 * GiB))
        self.assertEqual(s.get("pids_limit"), 512)
        self.assertEqual(str(s.get("shm_size")).lower(), "256m")
        self.assertRegex(tmpfs_of(s).get("/tmp", ""), r"size=(512m|536870912)")
        self.assertEqual(float(s.get("cpus")), 2.0)
        self.assertRegex(healthcheck_text(s), r"/internal/health")

    def test_sandbox_limits(self):  # AC-10.1
        s = svc("pdf-sandbox")
        self.assertEqual(to_bytes(s["mem_limit"]), 512 * 1024 ** 2)
        self.assertEqual(s.get("pids_limit"), 64)
        self.assertEqual(float(s.get("cpus")), 1.0)
        self.assertRegex(tmpfs_of(s).get("/work", ""), r"size=(256m|268435456)")
        self.assertRegex(healthcheck_text(s), r"/internal/health")

    def test_non_root_numeric_user(self):  # AC-09.2, AC-10.1
        for n in ("renderer", "pdf-sandbox"):
            u = uid_of(svc(n))
            self.assertRegex(u, r"^[0-9]+$", "%s user must be a numeric uid" % n)
            self.assertNotEqual(int(u), 0, n)

    def test_only_render_net_no_proxy_no_ports(self):  # AC-09.1
        for n in ("renderer", "pdf-sandbox"):
            s = svc(n)
            self.assertEqual(nets_of(s), {"render_net"})
            self.assertFalse(s.get("ports"), "%s publishes nothing" % n)
            self.assertFalse(s.get("extra_hosts"), "%s: no extra_hosts (no host-gateway escape)" % n)

    def test_only_own_inbound_token_mounted(self):  # AC-10.1 "exactly one secret", C6 02-TRD s2
        for n, tok, var in (("pdf-sandbox", "pdf_sandbox_inbound_token", "LIMS_RENDER_SANDBOX_TOKEN_FILE"),
                            ("renderer", "renderer_inbound_token", "LIMS_RENDERER_TOKEN_FILE")):
            s = svc(n)
            v = volumes_of(s)
            self.assertEqual(len(v), 1, "%s: exactly one mount, got %s" % (n, v))
            self.assertTrue(v[0][0].startswith("/run/lims/secrets/%s/" % n) and v[0][0].endswith(tok), v)
            self.assertTrue(v[0][2], "read-only")
            self.assertFalse(s.get("env_file"))
            self.assertTrue(env_of(s).get(var, "").startswith(v[0][1].rstrip("/")), "%s=%s" % (var, env_of(s).get(var)))
            self.assertFalse(s.get("secrets"))

    def test_no_db_storage_or_provider_secrets_in_env(self):  # 07-SEC A8
        for n in ("renderer", "pdf-sandbox"):
            for k in env_of(svc(n)):
                self.assertNotRegex(k, r"(?i)(PGPASS|DATABASE|POSTGRES|^PG|STORAGE|SERVICE_KEY|JWT|SMTP|CHANNEL|KEK)", "%s: %s" % (n, k))


# ---------------------------------------------------------------- compose: valkey / squid
class ValkeySquid(unittest.TestCase):
    def test_valkey_command_flags(self):  # AC-11.1, 02-TRD s7.4
        t = cmd_tokens(svc("valkey"))
        self.assertEqual(t[0], "valkey-server")

        def val(flag):
            self.assertIn(flag, t, flag)
            return t[t.index(flag) + 1]
        self.assertEqual(val("--save"), "")
        self.assertEqual(val("--appendonly"), "no")
        self.assertEqual(val("--maxmemory"), "256mb")
        self.assertEqual(val("--maxmemory-policy"), "volatile-ttl")
        self.assertEqual(val("--protected-mode"), "yes")
        self.assertEqual(val("--aclfile"), "/run/secrets/valkey/users.acl")
        self.assertNotIn("--requirepass", t)
        self.assertNotIn("--dir", t)

    def test_valkey_limits_no_volume_internal_only(self):  # AC-11.1, 04 S11
        s = svc("valkey")
        self.assertEqual(to_bytes(s["mem_limit"]), 320 * 1024 ** 2)
        self.assertEqual(float(s.get("cpus")), 0.5)
        self.assertEqual(nets_of(s), {"app_net"})
        self.assertFalse(s.get("ports"))
        # official image declares VOLUME /data -> an anonymous volume appears unless /data is a tmpfs
        self.assertIn("/data", tmpfs_of(s), "mount /data as tmpfs or `docker inspect` shows a volume")
        vols = volumes_of(s)
        self.assertEqual([v for v in vols if not v[0].startswith("/run/")], [], "no volume besides the rendered ACL file")
        self.assertEqual(len(vols), 1)
        self.assertEqual(vols[0][1], "/run/secrets/valkey/users.acl")
        self.assertTrue(vols[0][2])
        self.assertNotRegex(json.dumps(compose().get("volumes") or {}), r"valkey")

    def test_valkey_healthcheck(self):
        h = healthcheck_text(svc("valkey"))
        self.assertRegex(h, r"valkey-cli")
        self.assertRegex(h, r"ping")

    def test_squid_networks_and_limits(self):  # 02-TRD s7.4, s3.2
        s = svc("squid")
        self.assertEqual(nets_of(s), {"app_net", "egress_net"})
        self.assertEqual(to_bytes(s["mem_limit"]), 512 * 1024 ** 2)
        self.assertEqual(float(s.get("cpus")), 0.5)
        self.assertRegex(healthcheck_text(s), r"squidclient")
        self.assertFalse(s.get("ports"), "squid is only reachable on app_net")

    def test_only_squid_on_egress_net(self):  # 02-TRD s3.2 egress_net row
        self.assertEqual([n for n in ALL if "egress_net" in nets_of(svc(n))], ["squid"])


# ---------------------------------------------------------------- egress allowlist + squid conf
def allowlist():
    d = yaml.safe_load(need(ALLOW))
    if not isinstance(d, dict) or not isinstance(d.get("destinations"), list):
        raise AssertionError("egress-allowlist.yaml: top-level `destinations:` list required")
    return d["destinations"]


FQDN = re.compile(r"^(\.?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\{\{\s*[a-z_][a-z0-9_]*\s*\}\})$")


class EgressAllowlist(unittest.TestCase):
    KEYS = {"fqdn", "port", "via", "owner", "purpose", "section_04_11", "f01_status"}

    def test_schema(self):  # 02-TRD s5.5 last bullet, B11
        dest = allowlist()
        self.assertTrue(dest)
        for d in dest:
            self.assertEqual(set(d), self.KEYS, d)
            self.assertRegex(str(d["fqdn"]).lower(), FQDN, "fqdn must be a DNS name (no IP, no wildcard): %r" % d["fqdn"])
            self.assertIn(d["via"], ("squid", "smtp", "acme"))
            self.assertIn(d["f01_status"], ("approved", "pending", "refused"))
            self.assertIsInstance(d["port"], int)
            for k in ("owner", "purpose", "section_04_11"):
                self.assertTrue(str(d[k]).strip(), "%s empty in %s" % (k, d))
            if d["via"] == "squid":
                self.assertEqual(d["port"], 443, "Squid CONNECT is 443 only (02-TRD s5.5 rule 8)")

    def test_required_entries(self):  # T-14 row: GoTrue SMTP relay, ACME, C15 gateways
        dest = allowlist()
        smtp = [d for d in dest if d["via"] == "smtp"]
        self.assertTrue(smtp and all(d["port"] == 587 for d in smtp), "SMTP relay :587 (D-203)")
        self.assertTrue([d for d in dest if d["via"] == "acme"], "ACME CA endpoints")
        self.assertTrue([d for d in dest if d["owner"] == "C15"], "C15 gateway hosts (CR-C15-008 item 2)")

    def test_no_duplicates(self):
        keys = [(d["fqdn"], d["port"], d["via"]) for d in allowlist()]
        self.assertEqual(len(keys), len(set(keys)))

    def test_nothing_unapproved_hardcoded_in_squid_conf(self):  # B11: empty for any destination not approved
        t = need(ROLES / "egress_proxy" / "templates" / "squid.conf.j2")
        self.assertNotRegex(uncommented(t), r"(?m)^\s*acl\s+\S+\s+dstdomain\s+[a-z0-9.-]+\.[a-z]{2,}\s*$", "names come from the list")


def uncommented(t):
    return "\n".join(l for l in t.splitlines() if not l.strip().startswith("#"))


class SquidConf(unittest.TestCase):
    def render(self, names):
        return JENV.from_string(need(ROLES / "egress_proxy" / "templates" / "squid.conf.j2")).render(egress_proxy_fqdns=names)

    def test_allowlisted_names_only(self):  # AC-09.3 (403 for non-listed)
        out = uncommented(self.render(["api.allowed.example", "pay.allowed.example"]))
        self.assertIn("api.allowed.example", out)
        self.assertIn("pay.allowed.example", out)
        self.assertNotIn("evil.example", out)
        self.assertNotIn("UNDEF_", out)
        self.assertNotIn("UNDEF_", uncommented(self.render([])))

    def test_deny_by_default_and_connect_443_only(self):
        out = uncommented(self.render(["a.allowed.example"]))
        rules = [l.strip() for l in out.splitlines() if l.strip().startswith("http_access")]
        self.assertEqual(rules[-1], "http_access deny all")
        allows = [r for r in rules if r.startswith("http_access allow")]
        self.assertTrue(allows)
        for r in allows:
            self.assertNotRegex(r, r"\ball\b", "never `allow all`")
        self.assertRegex(out, r"(?m)^\s*acl\s+\S+\s+port\s+443\s*$")
        self.assertRegex(out, r"http_access deny CONNECT !\S+", "CONNECT only to the SSL port")
        self.assertRegex(out, r"(?m)^http_port 3128\b")
        self.assertNotRegex(out, r"http_access allow localhost|http_access allow manager", "no manager/localhost holes")

    def test_empty_list_allows_nothing(self):  # B11: all-pending allowlist -> every request is 403
        out = uncommented(self.render([]))
        self.assertEqual([l.strip() for l in out.splitlines() if l.strip().startswith("http_access allow")], [])


class ProxyRoleFiles(unittest.TestCase):
    def test_tasks_use_approved_entries_only_and_hourly_smtp_refresh(self):  # 02-TRD s5.5 rule 5
        r = ROLES / "egress_proxy"
        tasks = need(r / "tasks" / "main.yml")
        self.assertRegex(tasks, r"egress-allowlist\.yaml")
        self.assertRegex(tasks, r"approved")
        files = "\n".join(p.read_text(encoding="utf-8") for p in sorted(r.rglob("*")) if p.is_file())
        self.assertRegex(files, r"smtp_relay_ips")
        self.assertRegex(files, r"OnCalendar=hourly|OnUnitActiveSec=1h|OnCalendar=\*-\*-\* \*:00:00")
        self.assertRegex(files, r"nft\s+(add|flush|replace)")


# ---------------------------------------------------------------- valkey role
class ValkeyRole(unittest.TestCase):
    def acl(self):
        r = ROLES / "valkey"
        cands = sorted(p for p in (r / "templates").glob("*acl*")) if (r / "templates").is_dir() else []
        if not cands:
            raise AssertionError("roles/valkey/templates/*acl* missing")
        return cands[0]

    def test_acl_hash_only_and_least_privilege(self):  # AC-11.1, 07-SEC secrets
        out = JENV.from_string(self.acl().read_text(encoding="utf-8")).render(valkey_lims_api_password="Cl3arT3xtPw")
        self.assertNotIn("Cl3arT3xtPw", out, "clear text password in ACL file")
        self.assertNotIn("UNDEF_", out)
        h = _hash("Cl3arT3xtPw", "sha256")
        self.assertRegex(out, r"(?m)^user lims_api on [^\n]*#%s" % h)
        self.assertNotRegex(out, r">\s*Cl3ar")
        self.assertRegex(out, r"(?i)-@dangerous|(?=[\s\S]*-config)(?=[\s\S]*-flushall)")
        default = re.search(r"(?m)^user default (.*)$", out)
        if default:
            self.assertTrue(re.match(r"off\b", default.group(1)) or "-@all" in default.group(1), "default user must be off/restricted")
            self.assertNotIn("+@all", default.group(1))
        else:
            self.fail("ACL must state `user default ...` explicitly (off or -@all)")

    def test_default_off_requires_authenticated_healthcheck(self):
        out = JENV.from_string(self.acl().read_text(encoding="utf-8")).render(valkey_lims_api_password="x")
        m = re.search(r"(?m)^user default (.*)$", out)
        if m and m.group(1).startswith("off"):
            self.assertRegex(healthcheck_text(svc("valkey")), r"--user|--pass|-a\b|AUTH|\$\(cat|REDISCLI_AUTH", "default user off -> ping needs credentials")

    def test_tasks_tmpfs_nolog(self):
        t = need(ROLES / "valkey" / "tasks" / "main.yml")
        self.assertRegex(t, r"valkey_lims_api_password")
        self.assertRegex(t, r"no_log:\s*true")
        self.assertRegex(t, r"dest:\s*[\"']?/run/")
        self.assertRegex(t, r"mode:\s*[\"']?04[04]0")


# ---------------------------------------------------------------- playbook wiring
class SiteWiring(unittest.TestCase):
    NEW = ["valkey", "egress_proxy", "renderer_runtime", "lims_runtime"]

    def test_roles_exist(self):
        for r in self.NEW:
            for sub in ("tasks/main.yml",):
                need(ROLES / r / sub)
        need(ROLES / "lims_runtime" / "defaults" / "main.yml")

    def test_play_on_app_group_in_order(self):
        plays = yaml.safe_load(need(SITE))
        hit = [p for p in plays if "lims_runtime" in [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]]
        self.assertEqual(len(hit), 1, "exactly one play runs lims_runtime")
        p = hit[0]
        self.assertEqual(p["hosts"], "app")
        roles = [r if isinstance(r, str) else r.get("role") for r in p["roles"]]
        for r in self.NEW:
            self.assertIn(r, roles)
        for r in ("valkey", "egress_proxy", "renderer_runtime"):
            self.assertLess(roles.index(r), roles.index("lims_runtime"), r)

    def test_runtime_role_profile_and_mem_wiring(self):  # LD-45
        d = ROLES / "lims_runtime"
        text = "\n".join(p.read_text(encoding="utf-8") for p in sorted(d.rglob("*")) if p.is_file())
        self.assertRegex(text, r"topology_profile")
        self.assertRegex(text, r"COMPOSE_PROFILES|--profile")
        self.assertRegex(text, r"partner_enabled")
        self.assertRegex(text, r"mem_limit_gib")
        self.assertRegex(text, r"--wait|wait:\s*true")
        self.assertRegex(text, r"compose\.app\.yml")
        self.assertNotRegex(text, r"docker\.sock")

    def test_renderer_runtime_runs_deploy_tests(self):
        t = need(ROLES / "renderer_runtime" / "tasks" / "main.yml")
        for s in ("renderer_egress.sh", "sandbox_envelope.sh"):
            self.assertIn(s, t)

    def test_no_host_names_in_new_roles(self):  # LD-45: names come from the profile
        rx = re.compile(r"\b(data-1|app-1|dr-1|ops-1|prod-1|backup-1|dev-1)\b")
        for r in self.NEW:
            for p in (ROLES / r).rglob("*"):
                if p.is_file():
                    self.assertFalse(rx.search(p.read_text(encoding="utf-8")), rel(p))


# ---------------------------------------------------------------- memory budget (AC-30.1)
def run_hardening(*args):
    return subprocess.run([sys.executable, "-B", str(HARDENING), *args], capture_output=True, text=True, timeout=60)


def write_cfg(td, name, services):
    p = Path(td) / name
    p.write_text(json.dumps({"services": services}), encoding="utf-8")
    return str(p)


# 02-TRD s3.1 app-1 table (full profile): (replicas, GiB)
FULL_APP1 = {"api": (2, 2), "worker": (2, 2), "web": (2, 1), "portal": (1, 1), "partner": (1, 1), "renderer": (1, 1.5),
             "pdf-sandbox": (1, 0.5), "clamd": (1, 3), "valkey": (1, 0.3125), "squid": (1, 0.5), "supabase": (1, 2.75),
             "edge-agents": (1, 1.1875)}


def cfg_from(table, gib_unit=True):
    return {n: {"mem_limit": int(g * GiB), "deploy": {"replicas": r}} for n, (r, g) in table.items()}


class MemoryBudgetTool(unittest.TestCase):
    def test_tool_exists_and_daemon_mode_intact(self):
        need(HARDENING)
        r = run_hardening("--daemon-json", str(Path(tempfile.gettempdir()) / "definitely-missing-daemon.json"))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)

    def test_trd_full_table_sums_to_21_75_and_passes_on_32_not_16(self):  # 02-TRD s3.1, 08 A27.1
        self.assertAlmostEqual(sum(r * g for r, g in FULL_APP1.values()), 21.75)
        with tempfile.TemporaryDirectory() as td:
            f = write_cfg(td, "app.json", cfg_from(FULL_APP1))
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", f).returncode, 0)
            r = run_hardening("--memory-budget", "--ram-gib", "16", f)
            self.assertEqual(r.returncode, 1, r.stdout)

    def test_boundary_is_inclusive_at_85_percent(self):
        with tempfile.TemporaryDirectory() as td:
            ok = write_cfg(td, "ok.json", {"a": {"mem_limit": int(27.2 * GiB)}})
            over = write_cfg(td, "over.json", {"a": {"mem_limit": int(27.2 * GiB) + 1024 ** 2}})
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", ok).returncode, 0)
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", over).returncode, 1)
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", "--max-pct", "50", ok).returncode, 1)

    def test_sums_across_files_strings_and_replicas(self):  # Supabase + exporters + LIMS are separate projects on one host
        with tempfile.TemporaryDirectory() as td:
            a = write_cfg(td, "a.json", {"x": {"mem_limit": "10g"}, "y": {"mem_limit": "512m", "deploy": {"replicas": 2}}})
            b = write_cfg(td, "b.json", {"z": {"mem_limit": "16g"}})
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", a).returncode, 0)  # 11 GiB
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", a, b).returncode, 0)  # 27 <= 27.2
            r = run_hardening("--memory-budget", "--ram-gib", "32", a, a, b)
            self.assertEqual(r.returncode, 1, r.stdout)

    def test_service_without_limit_fails_and_is_named(self):  # unbounded container = budget unprovable
        with tempfile.TemporaryDirectory() as td:
            f = write_cfg(td, "n.json", {"fine": {"mem_limit": "1g"}, "unbounded-one": {"image": "x"}})
            r = run_hardening("--memory-budget", "--ram-gib", "32", f)
            self.assertEqual(r.returncode, 1)
            self.assertIn("unbounded-one", r.stdout)
            f0 = write_cfg(td, "z.json", {"zero": {"mem_limit": 0}})
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", f0).returncode, 1)

    def test_usage_and_garbage_input(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            good = write_cfg(td, "g.json", {"a": {"mem_limit": "1g"}})
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", str(bad)).returncode, 2)
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32", str(Path(td) / "none.json")).returncode, 2)
            self.assertEqual(run_hardening("--memory-budget", good).returncode, 2, "--ram-gib is required")
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "0", good).returncode, 2)
            self.assertEqual(run_hardening("--memory-budget", "--ram-gib", "32").returncode, 2, "no config files")


def inventory_budget(inv):
    hosts = yaml.safe_load(need(INV / inv / "hosts.yml"))
    out = []

    def walk(n):
        if isinstance(n, dict):
            if "mem_limit_gib" in n and "host_ram_gib" in n:
                out.append(n)
            for v in n.values():
                walk(v)
    walk(hosts)
    return out


class ProfileBudgets(unittest.TestCase):
    def test_every_lean_inventory_with_a_budget_fits_85_percent(self):  # LD-45: Sum <= 27.2 GiB on prod-1
        found = [i for i in ("prod-lean", "staging-lean") if inventory_budget(i)]
        self.assertIn("prod-lean", found)
        for inv in found:
            for h in inventory_budget(inv):
                total = sum(v["replicas"] * v["gib"] for v in h["mem_limit_gib"].values())
                self.assertLessEqual(total, 0.85 * h["host_ram_gib"], inv)

    def test_lean_budget_matches_compose_literals(self):  # one number, two places: they must agree
        h = inventory_budget("prod-lean")[0]["mem_limit_gib"]
        for name, key in (("renderer", "renderer"), ("pdf-sandbox", "pdf-sandbox"), ("valkey", "valkey"), ("squid", "squid")):
            self.assertAlmostEqual(to_bytes(svc(name)["mem_limit"]) / GiB, h[key]["gib"], msg=name)

    def test_lean_replicas_match_profile_services(self):  # lean: api x2, worker x1, web x1, portal 1, partner 0
        h = inventory_budget("prod-lean")[0]["mem_limit_gib"]
        lean = {n for n in ALL if not svc(n).get("profiles")}
        self.assertEqual(len([n for n in lean if n in API]), h["api"]["replicas"])
        self.assertEqual(len([n for n in lean if n in WORKERS]), h["worker"]["replicas"])
        self.assertEqual(len([n for n in lean if n in WEBS]), h["web"]["replicas"])
        self.assertEqual(int("portal" in lean), h["portal"]["replicas"])
        self.assertEqual(int("partner" in lean), h["partner"]["replicas"])

    def test_full_profile_defaults_fit_trd_table(self):  # compose defaults (all full services) <= TRD limits
        for n in API + WORKERS:
            self.assertLessEqual(to_bytes(svc(n)["mem_limit"]), 2 * GiB)
        for n in WEBS + ["portal", "partner"]:
            self.assertLessEqual(to_bytes(svc(n)["mem_limit"]), 1 * GiB)


if __name__ == "__main__":
    unittest.main()
