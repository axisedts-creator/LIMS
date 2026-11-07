"""T-01 tests (tester role): repo skeleton, infra lint/CI, secrets schema, .sops.yaml, ops-tools register.

Covers AC-05.2, AC-19.3 (schema part), AB-9 (07-SECURITY), 02-TRD s1/s2/s8.2/s12.4.
Stdlib only. Missing external tool = FAIL (never skip).
Run from repo root: python -I -m unittest discover -s infra/tests/static -p "test_t01_*.py" -v

NOTE: secret-looking fixtures are built at runtime so this file itself passes gitleaks.
"""
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
INFRA = ROOT / "infra"
ENVS = ("dev", "staging", "prod")

CI_SCRIPTS = (  # 02-TRD s1 tree: infra/ci/
    "build.sh scan.sh push.sh deploy.sh promote.sh smoke.sh rollback.sh release-lock.sh "
    "gen-routes.sh import-rules.sh ops-note.sh agent-release.sh"
).split()

# 02-TRD s8.2 upstream Supabase secrets (verbatim, compared case-insensitively)
UPSTREAM_IDS = (
    "POSTGRES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY "
    "JWT_KEYS JWT_JWKS DASHBOARD_USERNAME DASHBOARD_PASSWORD SECRET_KEY_BASE REALTIME_DB_ENC_KEY "
    "VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN "
    "S3_PROTOCOL_ACCESS_KEY_ID S3_PROTOCOL_ACCESS_KEY_SECRET MINIO_ROOT_PASSWORD POOLER_TENANT_ID "
    "SMTP_USER SMTP_PASS"
).lower().split()

# 02-TRD s8.2 table "ids added by the review fix pass" + AC-19.3 list (exact ids)
TABLE_IDS = (
    "valkey_lims_api_password bff_key_staff_web bff_key_partner bff_key_portal reporting_otp_hmac_key "
    "renderer_inbound_token pdf_sandbox_inbound_token core_storage_service_key instruments_config_signing_key "
    "instruments_release_signing_key instruments_authenticode_cert payments_kek internal_ca_key "
    "tenant_ops_contacts alert_contacts smtp_relay_gotrue"
).split()

DB_ROLES = "lims_migrator lims_api lims_worker lims_monitor lims_replicator lims_audit_ship".split()
# LIMS secrets with free names: any id containing the token satisfies (normalised: lowercase, '-'->'_')
FREE_TOKENS = (
    "lims_core_jwt_key lims_core_ratelimit_key lims_identity_token_enc_key lims_identity_gotrue_service_key "
    "repo1_cipher repo2_cipher sftp object_replica luks registry grafana_admin nginx_basic alertmanager_smtp wireguard"
).split()

# 02-TRD s2 ops tools -> (name regex, version regex or None, licence regex)
COPYLEFT = {
    "fail2ban": ("fail2ban", "1.1.1", r"GPL-2\.0"),
    "wireguard": ("wireguard", None, r"GPL-2\.0"),
    "nftables": ("nftables", None, r"GPL-2\.0"),
    "chrony": ("chrony", None, r"GPL-2\.0"),
    "ansible": ("ansible", "2.22.0", r"GPL-3\.0"),
    "sops": ("sops", "3.13.3", r"MPL-2\.0"),
    "grafana": ("grafana", "13.3.0", r"AGPL-3\.0"),
    "clamav": ("clamav", "1.5.4", r"GPL-2\.0"),
    "squid": ("squid", None, r"GPL-2\.0"),
    "testssl.sh": ("testssl", "3.2.5", r"GPL-2\.0"),
}
OTHER_TOOLS = (  # every other s2 row C1 runs (permissive); presence only
    "docker supabase postgres pgbouncer pgbackrest nginx certbot age prometheus alertmanager victorialogs "
    "fluent node_exporter postgres_exporter pgbouncer_exporter blackbox_exporter nginx-prometheus-exporter "
    "cadvisor valkey registry gitleaks trivy python authenticode"
).split()


def need_tool(tc, name):
    p = shutil.which(name)
    tc.assertIsNotNone(p, f"`{name}` not on PATH (missing tool = FAIL)")
    return p


def run(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, timeout=300, **kw)


def read(p):
    return p.read_text(encoding="utf-8")


def norm(s):
    return s.strip().strip("\"'").lower().replace("-", "_")


def schema_blocks(path):
    """{normalised id: block text}. Assumed syntax: list entries starting `- id: <id>`."""
    text = read(path)
    ms = list(re.finditer(r"(?m)^\s*-\s*id:\s*(\S+)", text))
    out = {}
    for i, m in enumerate(ms):
        end = ms[i + 1].start() if i + 1 < len(ms) else len(text)
        key = norm(m.group(1))
        assert key not in out, f"duplicate id {key} in {path.name}"
        out[key] = text[m.start():end]
    return out


def consumers_of(block):
    m = re.search(r"(?ms)^\s*consumers:(.*?)(?=^\s*[A-Za-z_]+:|\Z)", block)
    return (m.group(1) if m else "").lower()


class Skeleton(unittest.TestCase):
    def test_required_files_exist(self):
        want = ["README.md", "THIRD-PARTY-OPS.md", "secrets/.sops.yaml", "tests/run.sh"]
        want += [f"secrets/schema/{e}.secrets.schema.yaml" for e in ENVS]
        want += [f"ci/{s}" for s in CI_SCRIPTS]
        missing = [w for w in want if not (INFRA / w).is_file()]
        self.assertEqual(missing, [], f"missing under infra/: {missing}")

    def test_shell_scripts_have_shebang_and_parse(self):
        bash = need_tool(self, "bash")
        scripts = [INFRA / "tests/run.sh"] + [INFRA / "ci" / s for s in CI_SCRIPTS]
        for s in scripts:
            self.assertTrue(s.is_file(), f"{s} missing")
            self.assertTrue(read(s).startswith("#!"), f"{s.name}: no shebang")
            r = run([bash, "-n", s.as_posix()])
            self.assertEqual(r.returncode, 0, f"{s.name}: {r.stderr}")

    def test_readme_states_secrets_boundary(self):
        t = read(INFRA / "README.md").lower()
        self.assertIn("lims-secrets", t, "README must say secrets live in the separate lims-secrets repo")
        self.assertIn("tests/run.sh", t)


class Lint(unittest.TestCase):
    def test_yamllint_clean(self):
        y = need_tool(self, "yamllint")
        self.assertTrue(list(INFRA.rglob("*.yaml")), "no YAML under infra/ to lint")
        r = run([y, str(INFRA)], cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_ansible_lint_available_and_clean(self):
        # LD-17 (2026-11-07) T-01: ansible-lint does not run on native Windows; required only when CI=true.
        if os.environ.get("CI") != "true" and shutil.which("ansible-lint") is None:
            self.skipTest("SKIP ansible-lint (CI only)")
        a = need_tool(self, "ansible-lint")
        if (INFRA / "ansible").is_dir():  # created from T-02 on
            r = run([a, str(INFRA / "ansible")], cwd=ROOT)
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_run_sh_is_green(self):
        bash = need_tool(self, "bash")
        r = run([bash, (INFRA / "tests/run.sh").as_posix()], cwd=ROOT)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])


class Gitleaks(unittest.TestCase):  # AC-05.2, AB-9
    def test_infra_has_zero_findings(self):
        g = need_tool(self, "gitleaks")
        self.assertTrue(INFRA.is_dir())
        r = run([g, "detect", "--no-git", "--source", str(INFRA), "--no-banner", "--redact", "--exit-code", "1"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_scanner_catches_planted_secrets(self):  # proves the gate can fail (not a no-op config)
        g = need_tool(self, "gitleaks")
        with tempfile.TemporaryDirectory() as d:
            body = "".join(chr(65 + (i * 7) % 26) if i % 3 else chr(97 + (i * 5) % 26) for i in range(70))
            (Path(d) / "a.txt").write_text("token = " + "ghp_" + "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cD1fG3hJ5", encoding="utf-8")
            (Path(d) / "b.pem").write_text(
                "-----BEGIN " + "RSA PRIVATE KEY-----\n" + body + "\n" + body + "\n-----END " + "RSA PRIVATE KEY-----\n",
                encoding="utf-8")
            r = run([g, "detect", "--no-git", "--source", d, "--no-banner", "--exit-code", "1"])
            self.assertEqual(r.returncode, 1, "gitleaks must flag planted secrets: " + r.stdout + r.stderr)

    def test_no_decrypted_or_private_material_under_infra(self):  # SOPS metadata check
        bad_names = re.compile(r"(^\.env(\..*)?$|keys\.txt$|\.pem$|\.key$|\.p12$|\.pfx$|id_rsa|id_ed25519)", re.I)
        offenders = []
        for p in INFRA.rglob("*"):
            if not p.is_file() or ".git" in p.parts:
                continue
            if p.name.endswith((".example", ".sample")):
                continue
            if bad_names.search(p.name):
                offenders.append(f"{p.relative_to(ROOT)} (name)")
                continue
            if p == Path(__file__).resolve():
                continue
            try:
                t = read(p)
            except (UnicodeDecodeError, OSError):
                continue
            if "AGE-SECRET-KEY-" in t or "PRIVATE KEY-----" in t:
                offenders.append(f"{p.relative_to(ROOT)} (private key material)")
            if "ENC[AES256_GCM" in t and not (re.search(r"(?m)^sops:", t) and re.search(r"\bmac:", t)):
                offenders.append(f"{p.relative_to(ROOT)} (ENC[] without sops metadata)")
            if p.name.endswith(".enc.yaml"):
                offenders.append(f"{p.relative_to(ROOT)} (encrypted env files belong in lims-secrets, 02-TRD s8.2)")
        self.assertEqual(offenders, [])


class SopsConfig(unittest.TestCase):
    def setUp(self):
        self.text = read(INFRA / "secrets/.sops.yaml")

    def rules(self):
        parts = re.split(r"(?m)^\s*-\s*path_regex:", self.text)[1:]
        self.assertGreaterEqual(len(parts), 3, "need one creation rule per env")
        return parts

    def test_public_recipients_only(self):
        self.assertNotIn("AGE-SECRET-KEY", self.text)
        self.assertNotIn("PRIVATE KEY", self.text)

    def test_one_rule_per_env_with_distinct_age_recipients(self):
        recips = {}
        for env in ENVS:
            rule = [r for r in self.rules() if re.search(rf"\b{env}\b", r.split("\n", 1)[0])]
            self.assertEqual(len(rule), 1, f"exactly one creation rule for {env}")
            found = set(re.findall(r"\bage1[0-9a-z]{58}\b", rule[0]))
            self.assertTrue(found, f"{env}: no age1... public recipient (58 chars after age1)")
            recips[env] = found
        for a in ENVS:
            for b in ENVS:
                if a < b:
                    self.assertFalse(recips[a] & recips[b], f"{a} and {b} share a recipient (keys must be per env)")

    def test_prod_rule_matches_prod_file_name(self):
        rule = [r for r in self.rules() if re.search(r"\bprod\b", r.split("\n", 1)[0])][0]
        rx = rule.split("\n", 1)[0].strip().strip("\"'")
        self.assertTrue(re.search(rx, "prod.enc.yaml"), f"path_regex {rx!r} must match prod.enc.yaml")
        self.assertFalse(re.search(rx, "staging.enc.yaml"))


class SecretsSchema(unittest.TestCase):  # AC-19.3, TRD s8.2
    @classmethod
    def setUpClass(cls):
        cls.s = {e: schema_blocks(INFRA / f"secrets/schema/{e}.secrets.schema.yaml") for e in ENVS}

    def test_covers_every_id_of_trd_8_2_in_every_env(self):
        for env, ids in self.s.items():
            have = set(ids)
            miss = [i for i in UPSTREAM_IDS + TABLE_IDS if i not in have]
            miss += [f"<id containing {r}>" for r in DB_ROLES if not any(r in i for i in have)]
            miss += [f"<id containing {t}>" for t in FREE_TOKENS if not any(t in i for i in have)]
            if not any(i.startswith("reporting_channel_") for i in have):
                miss.append("reporting_channel_<secret_ref>")
            self.assertEqual(miss, [], f"{env}: missing ids")

    def test_every_entry_has_owner_consumers_rule_rotation_and_no_value(self):
        for env, ids in self.s.items():
            for i, b in ids.items():
                for k in ("owner:", "consumers:"):
                    self.assertIn(k, b, f"{env}/{i}: missing {k}")
                self.assertTrue(re.search(r"(?m)^\s*(format|length|rule)\w*:", b), f"{env}/{i}: no format/length/rule")
                self.assertTrue(re.search(r"(?m)^\s*rotation\w*:", b), f"{env}/{i}: no rotation")
                self.assertFalse(re.search(r"(?m)^\s*(value|default|secret|password)\s*:\s*\S", b),
                                 f"{env}/{i}: schema must hold names only, no values")

    def test_length_rules_of_upstream_env_example(self):
        want = {"jwt_secret": "32", "secret_key_base": "64", "realtime_db_enc_key": "16", "vault_enc_key": "32",
                "pg_meta_crypto_key": "32", "logflare_private_access_token": "32", "reporting_otp_hmac_key": "32"}
        for env, ids in self.s.items():
            for i, n in want.items():
                self.assertRegex(ids[i], rf"\b{n}\b", f"{env}/{i}: length rule {n} not stated")

    def test_rotation_intervals_conv(self):
        for env, ids in self.s.items():
            for i in ("bff_key_staff_web", "bff_key_partner", "bff_key_portal", "reporting_otp_hmac_key",
                      "renderer_inbound_token", "pdf_sandbox_inbound_token"):
                self.assertRegex(ids[i], r"365", f"{env}/{i}: rotation 365 d")
            for i, b in ids.items():
                if any(r in i for r in DB_ROLES) and re.search(r"pass|pw", i):
                    self.assertRegex(b, r"180", f"{env}/{i}: DB password rotation 180 d")

    def test_exposure_exceptions_are_only_env_and_include_valkey(self):  # AC-19.1 link
        for env, ids in self.s.items():
            for i, b in ids.items():
                for m in re.finditer(r"(?m)^\s*exposure:\s*(\S+)", b):
                    self.assertEqual(m.group(1).strip("\"'"), "env", f"{env}/{i}: exposure must be `env`")
            self.assertRegex(ids["valkey_lims_api_password"], r"(?m)^\s*exposure:\s*[\"']?env", env)
            for i in ("bff_key_staff_web", "payments_kek", "renderer_inbound_token", "reporting_otp_hmac_key"):
                self.assertNotRegex(ids[i], r"(?m)^\s*exposure:", f"{env}/{i} must use _FILE, not env")

    def test_ac_19_3_bff_keys_only_api_and_own_bff(self):
        own = {"bff_key_staff_web": "web", "bff_key_partner": "partner", "bff_key_portal": "portal"}
        for env, ids in self.s.items():
            for i, mine in own.items():
                c = consumers_of(ids[i])
                for need in ("api-a", "api-b", mine):
                    self.assertIn(need, c, f"{env}/{i}: consumer {need}")
                for other in {"web", "partner", "portal"} - {mine}:
                    self.assertNotIn(other, c, f"{env}/{i}: must not reach {other} BFF")
                for bad in ("worker", "ops-1", "data-1", "dr-1"):
                    self.assertNotIn(bad, c, f"{env}/{i}: {bad}")

    def test_ac_19_3_release_signing_and_authenticode_on_ops_only(self):
        for env, ids in self.s.items():
            for i in ("instruments_release_signing_key", "instruments_authenticode_cert"):
                c = consumers_of(ids[i])
                self.assertIn("ops-1", c, f"{env}/{i}")
                for bad in ("app-1", "api", "worker", "web", "data-1", "dr-1"):
                    self.assertNotIn(bad, c, f"{env}/{i}: must exist on no product host ({bad})")

    def test_ac_19_3_payments_kek_read_only_api_and_workers(self):
        for env, ids in self.s.items():
            b = ids["payments_kek"]
            c = consumers_of(b)
            for need in ("api-a", "api-b", "worker-a", "worker-b"):
                self.assertIn(need, c, f"{env}: {need}")
            for bad in ("ops-1", "data-1", "dr-1", "web", "portal", "partner"):
                self.assertNotIn(bad, c, f"{env}: payments_kek must not reach {bad}")
            self.assertRegex(b, r"(?i)read[-_ ]?only|\bro\b|:ro\b", f"{env}: payments_kek must be read-only")

    def test_core_storage_service_key_scope(self):  # C0 handoff: only core storage adapter hosts
        for env, ids in self.s.items():
            c = consumers_of(ids["core_storage_service_key"])
            for need in ("api-a", "api-b", "worker-a", "worker-b"):
                self.assertIn(need, c)
            self.assertNotIn("ops-1", c)


class ThirdPartyOps(unittest.TestCase):  # CR-C1-007 condition; done_when
    @classmethod
    def setUpClass(cls):
        cls.text = read(INFRA / "THIRD-PARTY-OPS.md")
        cls.rows = []
        header = None
        for ln in cls.text.splitlines():
            if not ln.strip().startswith("|"):
                continue
            cells = [c.strip() for c in ln.strip().strip("|").split("|")]
            if set("".join(cells)) <= set("-: "):
                continue
            if header is None:
                header = [c.lower() for c in cells]
                continue
            cls.rows.append(cells)
        cls.header = header or []

    def test_header_columns(self):
        h = " | ".join(self.header)
        for col in ("name", "version", "licen", "host", "reachable from"):
            self.assertIn(col, h, f"column `{col}`")

    def test_rows_complete(self):
        self.assertGreaterEqual(len(self.rows), 20)
        for r in self.rows:
            self.assertGreaterEqual(len(r), 5, r)
            self.assertTrue(all(c for c in r[:5]), f"empty cell in row {r}")

    def row(self, rx):
        hits = [r for r in self.rows if re.search(rx, r[0], re.I)]
        self.assertTrue(hits, f"no row for {rx}")
        return hits[0]

    def test_every_gpl_agpl_mpl_tool_listed_with_trd_version_and_licence(self):
        for key, (name, ver, lic) in COPYLEFT.items():
            r = self.row(name)
            self.assertRegex(" ".join(r), lic, f"{key}: licence")
            if ver:
                self.assertIn(ver, " ".join(r), f"{key}: version {ver}")

    def test_authenticode_tool_row_exists_licence_recorded_in_t34(self):
        self.row("authenticode")

    def test_other_trd_s2_tools_registered(self):
        names = " ".join(r[0].lower() for r in self.rows)
        miss = [t for t in OTHER_TOOLS if t not in names]
        self.assertEqual(miss, [], f"tools without a row: {miss}")

    def test_states_cr_c1_007_conditions(self):
        t = self.text.lower()
        for phrase in ("cr-c1-007", "unmodified", "separate process", "ops network"):
            self.assertIn(phrase, t)


if __name__ == "__main__":
    unittest.main()
