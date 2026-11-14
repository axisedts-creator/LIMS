#!/usr/bin/env python3
"""Audit-store schema drift check (02-TRD s10.3, 05-SCHEMA s3.5, 08 A29.2; CI job `auditstore-drift`, gen-schema.sh --apply).

    python3 drift.py SOURCE.json SUBSCRIBER.json [--apply-sql]

Inputs: JSON lists of information_schema.columns rows {table_schema, table_name, column_name, data_type, udt_name?,
is_nullable 'YES'|'NO'} from the primary (SOURCE) and the audit store (SUBSCRIBER). Compares names, types and
nullability; row order is ignored.
Exit 0 = identical, 1 = drift (one line per difference: `<kind> schema.table.column ...`, kind in
missing|extra|type|nullability), 2 = unreadable/invalid input or an empty source (comparing nothing never passes).
--apply-sql: SQL on stdout for the differences gen-schema.sh --apply may fix (ADD COLUMN, never NOT NULL; DROP NOT NULL
where only the store has it); the report goes to stderr. Never SET NOT NULL, DROP COLUMN or a type change: if any
such difference remains the exit code is still 1. Stdlib only.
"""
import json
import re
import sys

KEYS = ("table_schema", "table_name", "column_name", "data_type", "is_nullable")
SAFE_TYPE = re.compile(r"^[a-z][a-z0-9 ]*$")
SAFE_UDT = re.compile(r"^[a-z_][a-z0-9_]*$")


class Bad(Exception):
    pass


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
    except (OSError, ValueError) as e:
        raise Bad("%s: %s" % (path, e))
    if not isinstance(rows, list):
        raise Bad("%s: not a JSON list" % path)
    out = {}
    for r in rows:
        if not isinstance(r, dict) or any(not isinstance(r.get(k), str) for k in KEYS):
            raise Bad("%s: row lacks %s: %r" % (path, "/".join(KEYS), r))
        if r["is_nullable"] not in ("YES", "NO"):
            raise Bad("%s: is_nullable must be YES|NO: %r" % (path, r))
        udt = r.get("udt_name")
        if udt is not None and not isinstance(udt, str):
            raise Bad("%s: udt_name must be a string: %r" % (path, r))
        key = (r["table_schema"], r["table_name"], r["column_name"])
        if key in out:
            raise Bad("%s: duplicate column %s" % (path, ".".join(key)))
        out[key] = r
    return out


def ident(name):
    return '"%s"' % name.replace('"', '""')


def sql_type(r):
    """Type text for ADD COLUMN, or None when it cannot be written safely (then the difference is not fixable)."""
    dt, udt = r["data_type"], r.get("udt_name")
    if dt == "ARRAY":
        return (udt[1:] + "[]") if udt and udt.startswith("_") and SAFE_UDT.match(udt[1:]) else None
    if dt == "USER-DEFINED":
        return ident(udt) if udt else None
    return dt if SAFE_TYPE.match(dt) else None


def same_type(a, b):
    if a["data_type"] != b["data_type"]:
        return False
    ua, ub = a.get("udt_name"), b.get("udt_name")
    return ua is None or ub is None or ua == ub


def main(argv):
    args = [a for a in argv if a != "--apply-sql"]
    apply_sql = len(args) != len(argv)
    if len(args) != 2:
        print(__doc__.strip().splitlines()[2].strip(), file=sys.stderr)
        return 2
    try:
        src, sub = load(args[0]), load(args[1])
    except Bad as e:
        print("drift: invalid input: %s" % e, file=sys.stderr)
        return 2
    if not src:
        print("drift: empty source column list (nothing compared)", file=sys.stderr)
        return 2

    report, sql, unfixed = [], [], 0
    for key in sorted(set(src) | set(sub)):
        name = ".".join(key)
        table = "%s.%s" % (ident(key[0]), ident(key[1]))
        a, b = src.get(key), sub.get(key)
        if b is None:
            report.append("missing %s (in source, not in store)" % name)
            t = sql_type(a)
            if t:
                sql.append("ALTER TABLE %s ADD COLUMN %s %s;" % (table, ident(key[2]), t))
            else:
                unfixed += 1
            continue
        if a is None:
            report.append("extra %s (in store, not in source)" % name)
            unfixed += 1
            continue
        if not same_type(a, b):
            report.append("type %s: source %s/%s, store %s/%s" % (
                name, a["data_type"], a.get("udt_name"), b["data_type"], b.get("udt_name")))
            unfixed += 1
        if a["is_nullable"] != b["is_nullable"]:
            report.append("nullability %s: source is_nullable=%s, store is_nullable=%s" % (
                name, a["is_nullable"], b["is_nullable"]))
            if a["is_nullable"] == "YES":
                sql.append("ALTER TABLE %s ALTER COLUMN %s DROP NOT NULL;" % (table, ident(key[2])))
            else:
                unfixed += 1

    if apply_sql:
        for line in report:
            print(line, file=sys.stderr)
        for line in sql:
            print(line)
        return 1 if unfixed else 0
    for line in report:
        print(line)
    return 1 if report else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
