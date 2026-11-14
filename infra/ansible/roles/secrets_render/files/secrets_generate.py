#!/usr/bin/env python3
"""02-TRD s8.2: build the full secret set of ONE env as YAML on stdout (never a file).

Usage: secrets_generate.py --schema <env>.secrets.schema.yaml --workdir EMPTY_DIR
                           [--keys-script PATH]...  < operator-supplied YAML (or empty)
Per schema id:
  upstream (POSTGRES_PASSWORD .. SMTP_PASS) : `KEY=value` lines printed by the pinned snapshot's
      key scripts (run with cwd=--workdir, stdin closed); keys/JWTs MUST come from them.
  format "random string|key|token", "identifier", or a `length:` rule : generated here (secrets).
  format "... generated on the host" (wireguard) : marker `host-generated:<env>`, real key stays on host.
  anything else (SSH/htpasswd/key material, certs, contacts, relay creds, reporting_channel_<..>):
      taken from the stdin YAML (operator decrypts it from sops; never on disk).
Missing ids -> exit 1 with the id names only. Never prints a value to stderr.
"""
import argparse
import os
import re
import secrets
import string
import subprocess
import sys

import yaml

ALNUM = string.ascii_letters + string.digits  # env-file safe (no ' or newline, AC-19.1 URL rule)
DEFAULT_LEN = 48
RANDOM_FMT = re.compile(r"^(random (string|key|token)\b|identifier\b)")
SCRIPT_REQUIRED = re.compile(r"generate-keys\.sh|JWT signed")


def _rand(n):
    return "".join(secrets.choice(ALNUM) for _ in range(n))


def _length(rule):
    m = re.match(r"^\s*(>=|exactly)\s+(\d+)\b", str(rule or ""))
    return (int(m.group(2)), m.group(1) == "exactly") if m else (None, False)


def script_values(scripts, workdir):
    out = {}
    for s in scripts:
        p = subprocess.run(["sh", s], cwd=workdir, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                           timeout=120)
        if p.returncode != 0:
            sys.stderr.write("key script failed: %s (exit %d)\n" % (os.path.basename(s), p.returncode))
            sys.exit(1)
        for line in p.stdout.splitlines():
            m = re.match(r"^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*?)\s*$", line)
            if m:
                v = m.group(2)
                if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                    v = v[1:-1]
                if v:
                    out[m.group(1)] = v
    return out


def build(schema, scripted, extra):
    env = schema["env"]
    out, missing = {}, []
    prefixes = [s["id"].split("<")[0] for s in schema["secrets"] if "<" in s["id"]]
    for s in schema["secrets"]:
        i, fmt = s["id"], str(s.get("format") or "")
        if "<" in i:
            continue
        n, exact = _length(s.get("length"))
        if i in scripted:
            out[i] = scripted[i]
        elif SCRIPT_REQUIRED.search(fmt) and "random string" not in fmt:
            missing.append(i + " (expected from key scripts)")
        elif "generated on the host" in fmt:
            out[i] = "host-generated:" + env  # [CONV] placeholder; the key never leaves its host
        elif RANDOM_FMT.search(fmt) or n:
            out[i] = _rand(n if exact else max(n or 0, DEFAULT_LEN))
        elif i in extra:
            out[i] = extra[i]
        else:
            missing.append(i + " (operator-supplied)")
    for k, v in extra.items():
        if any(k.startswith(p) and len(k) > len(p) for p in prefixes):
            if not re.match(r"^[A-Za-z0-9_]+$", k):
                missing.append("%s (bad id)" % k)
            out[k] = v
    return out, missing


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--schema", required=True)
    ap.add_argument("--workdir", required=True)
    ap.add_argument("--keys-script", action="append", default=[])
    a = ap.parse_args(argv)
    if not os.path.isdir(a.workdir) or os.listdir(a.workdir):
        sys.stderr.write("workdir must exist and be empty\n")
        return 2
    with open(a.schema, encoding="utf-8") as f:
        schema = yaml.safe_load(f)
    try:
        extra = yaml.safe_load(sys.stdin.read() or "{}") or {}
    except yaml.YAMLError as e:  # never echo the parser context (it holds values)
        sys.stderr.write("stdin: %s\n" % type(e).__name__)
        return 2
    if not isinstance(extra, dict):
        sys.stderr.write("stdin must be a YAML mapping\n")
        return 2
    values, missing = build(schema, script_values(a.keys_script, a.workdir), extra)
    if missing:
        sys.stderr.write("missing: " + ", ".join(missing) + "\n")
        return 1
    yaml.safe_dump(values, sys.stdout, default_flow_style=False, sort_keys=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
