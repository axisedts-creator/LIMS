#!/usr/bin/env python3
"""AC-19.1 / AC-19.3: `docker inspect` scan of ONE host - file-mounted secrets never in env/cmd/labels.

Input : --inspect  `docker inspect $(docker ps -q)` JSON ("-" = stdin)
        --secrets-dir  rendered tree /run/lims/secrets (<service>/<id> files) of the SAME host
        --schema  infra/secrets/schema/<env>.secrets.schema.yaml (ids with `exposure: env` are exempt)
Checks: (1) no Env/Cmd/Args/Label value (len>=8) equals the content of a rendered file secret whose id is not
        `exposure: env`  (2) payments_kek mounted read-only, only in api-a/b, worker-a/b
        (3) bff_key_* mounted only in api-a/b + its own BFF (staff_web->web, partner->partner, portal->portal)
        (4) instruments_release_signing_key / instruments_authenticode_cert mounted nowhere (ops-1 only).
Output: `VIOLATION <container>: <reason>` (ids only, NEVER a value). Exit 0 ok, 1 violation, 2 usage.
"""
import argparse
import json
import os
import sys

import yaml

CORE = {"api-a", "api-b"}
ALLOWED = {
    "payments_kek": CORE | {"worker-a", "worker-b"},
    "bff_key_staff_web": CORE | {"web"},
    "bff_key_partner": CORE | {"partner"},
    "bff_key_portal": CORE | {"portal"},
}
OPS_ONLY = {"instruments_release_signing_key", "instruments_authenticode_cert"}


def _service(c):
    return (c.get("Config", {}).get("Labels") or {}).get("com.docker.compose.service") or c.get("Name", "?").lstrip("/")


def _strings(c):
    cfg = c.get("Config", {})
    for e in cfg.get("Env") or []:
        yield e.split("=", 1)[1] if "=" in e else e
    for x in (cfg.get("Cmd") or []) + (cfg.get("Entrypoint") or []) + (c.get("Args") or []):
        yield x
    for v in (cfg.get("Labels") or {}).values():
        yield v


def read_secrets(root):
    out = {}  # id -> set(values)
    for d, _, files in os.walk(root):
        for f in files:
            try:
                with open(os.path.join(d, f), encoding="utf-8") as fh:
                    v = fh.read().rstrip("\n")
            except (OSError, UnicodeDecodeError):
                continue
            if len(v) >= 8:
                out.setdefault(f, set()).add(v)
    return out


def check(containers, secrets, env_ids):
    errs = []
    for c in containers:
        name = _service(c)
        strs = list(_strings(c))
        for sid, vals in secrets.items():
            if sid in env_ids:
                continue
            if any(s in vals or any(v in s for v in vals) for s in strs):
                errs.append("%s: value of file secret %s visible in inspect env/cmd/labels" % (name, sid))
        for m in c.get("Mounts") or []:
            src = (m.get("Source") or "").replace("\\", "/")
            sid = src.rstrip("/").rsplit("/", 1)[-1]
            if sid in OPS_ONLY:
                errs.append("%s: %s mounted on a product host" % (name, sid))
            if sid in ALLOWED:
                if name not in ALLOWED[sid]:
                    errs.append("%s: %s mounted in a service not allowed to read it" % (name, sid))
                if sid == "payments_kek" and m.get("RW", False):
                    errs.append("%s: payments_kek mounted read-write" % name)
    return errs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--inspect", required=True)
    ap.add_argument("--secrets-dir", required=True)
    ap.add_argument("--schema", required=True)
    a = ap.parse_args(argv)
    try:
        with (sys.stdin if a.inspect == "-" else open(a.inspect, encoding="utf-8")) as f:
            containers = json.load(f)
        with open(a.schema, encoding="utf-8") as f:
            schema = yaml.safe_load(f)
    except (OSError, ValueError, yaml.YAMLError) as e:
        sys.stderr.write("cannot read input: %s\n" % type(e).__name__)
        return 2
    if not isinstance(containers, list) or not os.path.isdir(a.secrets_dir):
        sys.stderr.write("inspect must be a JSON list and --secrets-dir a directory\n")
        return 2
    env_ids = {s["id"] for s in schema["secrets"] if s.get("exposure") == "env"}
    errs = check(containers, read_secrets(a.secrets_dir), env_ids)
    for e in errs:
        print("VIOLATION " + e)
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
