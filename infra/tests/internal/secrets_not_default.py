#!/usr/bin/env python3
"""AC-05.1 / AC-21.1 / 07-SEC: decrypted secret set of ONE env vs schema, .env.example, other envs.

Input : --values  decrypted `<env>.enc.yaml` as YAML id->value ("-" = stdin; runner memory only)
        --schema  infra/secrets/schema/<env>.secrets.schema.yaml   (default derived from --env)
        --env-example  pinned upstream .env.example                (default: pinned snapshot)
        --other ENV=FILE (repeatable)  decrypted values of the other envs (cross-env uniqueness)
Checks: (1) id set == schema id set (ids `<...>` = prefix pattern, zero or more)  (2) no value empty
        (3) every upstream id of 02-TRD s8.2 differs from its .env.example value  (4) length rules
        (TRD s8.2 + schema `length:`)  (5) repo1/repo2 pgBackRest cipher pass differ
        (6) no value of this env equals any value of --other envs.
Output: one `VIOLATION <id>: <reason>` line each. NEVER prints a value. Exit 0 ok, 1 violation, 2 usage.
"""
import argparse
import hashlib
import json
import os
import re
import sys

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PINNED = os.path.join(ROOT, "infra", "compose", "supabase", "upstream", ".env.example")
UPSTREAM_IDS = [
    "POSTGRES_PASSWORD", "JWT_SECRET", "ANON_KEY", "SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY", "JWT_KEYS", "JWT_JWKS", "DASHBOARD_USERNAME", "DASHBOARD_PASSWORD",
    "SECRET_KEY_BASE", "REALTIME_DB_ENC_KEY", "VAULT_ENC_KEY", "PG_META_CRYPTO_KEY",
    "LOGFLARE_PUBLIC_ACCESS_TOKEN", "LOGFLARE_PRIVATE_ACCESS_TOKEN", "S3_PROTOCOL_ACCESS_KEY_ID",
    "S3_PROTOCOL_ACCESS_KEY_SECRET", "MINIO_ROOT_PASSWORD", "POOLER_TENANT_ID", "SMTP_USER", "SMTP_PASS",
]
# 02-TRD s8.2 quoted from .env.example: (min, max); exact n = (n, n)
TRD_LENGTH = {
    "JWT_SECRET": (32, None), "SECRET_KEY_BASE": (64, None), "REALTIME_DB_ENC_KEY": (16, 16),
    "VAULT_ENC_KEY": (32, 32), "PG_META_CRYPTO_KEY": (32, None), "LOGFLARE_PUBLIC_ACCESS_TOKEN": (1, None),
    "LOGFLARE_PRIVATE_ACCESS_TOKEN": (32, None),
}


def _norm(v):
    return v if isinstance(v, str) else json.dumps(v, sort_keys=True)


def _h(v):
    return hashlib.sha256(_norm(v).encode()).hexdigest()


def parse_env_example(path):
    out = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                v = m.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                out[m.group(1)] = v
    return out


def parse_length(rule):
    """'>= 32 chars' | 'exactly 16 chars' | '>= 32 random bytes' -> (min, max) or None."""
    m = re.match(r"^\s*(>=|exactly)\s+(\d+)\b", str(rule or ""))
    if not m:
        return None
    n = int(m.group(2))
    return (n, None) if m.group(1) == ">=" else (n, n)


def check(values, schema, example, others):
    errs = []
    ids = [s["id"] for s in schema["secrets"]]
    fixed = {i for i in ids if "<" not in i}
    prefixes = [i.split("<")[0] for i in ids if "<" in i]
    for i in sorted(fixed - set(values)):
        errs.append("%s: missing (in schema, not in values)" % i)
    for i in sorted(set(values) - fixed):
        if not any(i.startswith(p) and len(i) > len(p) for p in prefixes):
            errs.append("%s: extra (not in schema)" % i)
    lengths = {k: v for k, v in TRD_LENGTH.items()}
    for s in schema["secrets"]:
        r = parse_length(s.get("length"))
        if r:
            lo, hi = lengths.get(s["id"], (0, None))
            lengths[s["id"]] = (max(lo, r[0]), r[1] if r[1] is not None else hi)
    for i, v in sorted(values.items()):
        sv = _norm(v) if v is not None else ""
        if not sv.strip():
            errs.append("%s: empty value" % i)
            continue
        if i in UPSTREAM_IDS and i in example and sv == example[i]:
            errs.append("%s: equals the .env.example default" % i)
        if i in lengths:
            lo, hi = lengths[i]
            if len(sv) < lo or (hi is not None and len(sv) > hi):
                errs.append("%s: length rule violated (need %s%d)" % (i, "exactly " if hi == lo else ">= ", lo))
    a, b = values.get("pgbackrest_repo1_cipher_pass"), values.get("pgbackrest_repo2_cipher_pass")
    if a is not None and a == b:
        errs.append("pgbackrest_repo2_cipher_pass: equals repo1 cipher pass (must differ)")
    for env, ovals in others.items():
        oh = {_h(v) for v in ovals.values() if _norm(v).strip()}
        for i, v in sorted(values.items()):
            if _norm(v).strip() and _h(v) in oh:
                errs.append("%s: value shared with env %s (secrets are per env)" % (i, env))
    return errs


def _load(path):
    try:
        with (sys.stdin if path == "-" else open(path, encoding="utf-8")) as f:
            return yaml.safe_load(f)
    except (OSError, yaml.YAMLError) as e:
        sys.stderr.write("cannot read %s: %s\n" % (path if path != "-" else "stdin", type(e).__name__))
        sys.exit(2)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--env", required=True)
    ap.add_argument("--values", required=True)
    ap.add_argument("--schema")
    ap.add_argument("--env-example", default=PINNED)
    ap.add_argument("--other", action="append", default=[], metavar="ENV=FILE")
    a = ap.parse_args(argv)
    schema = _load(a.schema or os.path.join(ROOT, "infra", "secrets", "schema", "%s.secrets.schema.yaml" % a.env))
    values = _load(a.values)
    if not isinstance(values, dict) or not isinstance(schema, dict) or "secrets" not in schema:
        sys.stderr.write("values must be a mapping and schema needs `secrets:`\n")
        return 2
    if schema.get("env") != a.env:
        sys.stderr.write("schema env %r != --env %r\n" % (schema.get("env"), a.env))
        return 2
    if not os.path.isfile(a.env_example):
        sys.stderr.write("env-example not found: %s\n" % a.env_example)
        return 2
    others = {}
    for o in a.other:
        if "=" not in o:
            sys.stderr.write("--other needs ENV=FILE\n")
            return 2
        e, p = o.split("=", 1)
        ov = _load(p)
        if not isinstance(ov, dict):
            sys.stderr.write("--other %s: not a mapping\n" % e)
            return 2
        others[e] = ov
    errs = check(values, schema, parse_env_example(a.env_example), others)
    for e in errs:
        print("VIOLATION " + e)
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
