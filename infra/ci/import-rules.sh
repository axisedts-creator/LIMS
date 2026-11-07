#!/usr/bin/env bash
# infra/ci/import-rules.sh [--check] - import chunk-owned alert rule files (02-TRD s11.3, 08 A13 P-14).
# Copies each source into rules/imported/<module>.rules.yml adding only labels.severity (if missing),
# labels.team (if missing) and annotations.runbook_url; alert/expr/for/other labels stay verbatim.
# --check (CI job alert-import-drift): writes nothing, exits 1 naming each drifted/missing module.
# A missing source is skipped. Fails closed (exit 1, nothing written) on a bad alert name, missing
# alert/expr, severity not page|warn|info, a s11.2 drop-list label or an e-mail address in a rule.
# Env: LIMS_IMPORT_SRC_ROOT (default repo root), LIMS_IMPORT_OUT_DIR (default rules/imported).
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && { pwd -W 2>/dev/null || pwd; })
PY=$(command -v python3 || command -v python) || { echo "python3 missing" >&2; exit 2; }
export LIMS_IMPORT_REPO_ROOT="$here"
exec "$PY" -P - "$@" <<'PYEOF'
import glob, json, os, re, sys
import yaml

MAP = {  # module -> source glob (02-TRD s11.3 intake table); new rows arrive by the owner's P-14 CR
    "catalog": "services/api/src/modules/catalog/ops/alerts.yaml",
    "billing": "services/worker/src/jobs/billing/alerts/*.yaml",
    "frontdesk": "services/worker/src/jobs/frontdesk/alerts/*.yaml",
    "lab": "services/worker/src/jobs/lab/ops/lab.rules.yml",
    "reporting": "services/worker/src/jobs/reporting/alerts/reporting.rules.yaml",
    "instruments": "services/worker/src/jobs/instruments/alerts/instruments.rules.yml",
    "analytics": "services/worker/src/jobs/analytics/ops/analytics.rules.yml",
    "quality": "services/worker/src/jobs/quality/ops/quality.rules.yml",
    "inventory": "services/worker/src/jobs/inventory/ops/inventory.rules.yml",
    "smartreport": "services/worker/src/jobs/smartreport/ops/smartreport.rules.yml",
}
SEVS = ("page", "warn", "info")
NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
# (?<![-\w])/(?![-\w]): hyphen-joined receiver names (`oncall-email`, `ops-digest-email`, 02-TRD s11.3/s11.4) are not labels.
DROP = re.compile(r"(?<![-\w])(patient_id|order_id|specimen_id|barcode|user_id|membership_id|email|phone)(?![-\w])")
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+")
DEFAULT_SEV, DEFAULT_TEAM = "warn", "ops"  # [CONV] when the source carries none


class Dumper(yaml.SafeDumper):  # indented sequences (yamllint default)
    def increase_indent(self, flow=False, indentless=False):
        return super().increase_indent(flow, False)


def _str(d, v):  # long scalars folded (readability); safe_load round-trips them identically
    return d.represent_scalar("tag:yaml.org,2002:str", v, style=">" if len(v) > 40 and "\n" not in v else None)


Dumper.add_representer(str, _str)


def fail(msg):
    print("import-rules: %s" % msg, file=sys.stderr)
    sys.exit(1)


def transform(module, rule, where):
    blob = json.dumps(rule, ensure_ascii=False)
    if DROP.search(blob):
        fail("%s: drop-list label in rule (02-TRD s11.2)" % where)
    if EMAIL.search(blob):
        fail("%s: e-mail address in rule" % where)
    if "record" in rule and "alert" not in rule:
        return rule  # recording rule: verbatim
    name, expr = rule.get("alert"), rule.get("expr")
    if not isinstance(name, str) or not NAME.fullmatch(name):
        fail("%s: bad or missing alert name %r" % (where, name))
    if not isinstance(expr, (str, int, float)) or not str(expr).strip():
        fail("%s: %s has no expr" % (where, name))
    labels = dict(rule.get("labels") or {})
    labels.setdefault("severity", DEFAULT_SEV)
    if labels["severity"] not in SEVS:
        fail("%s: %s severity %r not page|warn|info" % (where, name, labels["severity"]))
    if not str(labels.get("team") or "").strip():
        labels["team"] = DEFAULT_TEAM
    ann = dict(rule.get("annotations") or {})
    if not str(ann.get("summary") or "").strip():  # 02-TRD s11.3: every alert needs a summary; owner's wins when present
        ann["summary"] = "%s is firing" % name
    ann["runbook_url"] = "infra/runbooks/%s.md#%s" % (module, name.lower())
    out = {}
    for k, v in rule.items():
        out[k] = labels if k == "labels" else ann if k == "annotations" else v
    out.setdefault("labels", labels)
    out.setdefault("annotations", ann)
    return out


def render(module, root):
    files = sorted(glob.glob(os.path.join(root, MAP[module])))
    if not files:
        return None
    groups = []
    for f in files:
        rel = os.path.relpath(f, root).replace(os.sep, "/")
        try:
            with open(f, encoding="utf-8") as fh:
                doc = yaml.safe_load(fh)
        except yaml.YAMLError as e:
            fail("%s: invalid YAML (%s)" % (rel, e.__class__.__name__))
        if not isinstance(doc, dict) or not isinstance(doc.get("groups"), list):
            fail("%s: no groups list" % rel)
        for g in doc["groups"]:
            if not isinstance(g, dict) or not isinstance(g.get("rules"), list):
                fail("%s: group without rules list" % rel)
            g = dict(g)
            g["rules"] = [transform(module, r if isinstance(r, dict) else fail("%s: rule not a mapping" % rel),
                                    "%s (%s)" % (rel, module)) for r in g["rules"]]
            groups.append(g)
    head = ("---\n# yamllint disable rule:line-length\n# GENERATED by infra/ci/import-rules.sh from %s - do not edit;\n"
            "# change the source (owner chunk) and re-run. alert-import-drift checks this file.\n" % MAP[module])
    return head + yaml.dump({"groups": groups}, Dumper=Dumper, sort_keys=False, width=72, allow_unicode=True)


def main(argv):
    if argv not in ([], ["--check"]):
        print("usage: import-rules.sh [--check]", file=sys.stderr)
        sys.exit(2)
    check = argv == ["--check"]
    repo = os.environ["LIMS_IMPORT_REPO_ROOT"]
    root = os.environ.get("LIMS_IMPORT_SRC_ROOT") or repo
    out_dir = os.environ.get("LIMS_IMPORT_OUT_DIR") or os.path.join(repo, "infra/monitoring/rules/imported")
    planned = {m: t for m in MAP for t in [render(m, root)] if t is not None}  # all validated before any write
    drift = []
    for m, text in planned.items():
        dst = os.path.join(out_dir, "%s.rules.yml" % m)
        cur = open(dst, encoding="utf-8", newline="").read() if os.path.isfile(dst) else None
        if cur == text:
            continue
        if check:
            drift.append("%s (%s)" % (m, "missing" if cur is None else "differs from source"))
            continue
        tmp = dst + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, dst)
        print("import-rules: wrote %s.rules.yml" % m)
    if drift:
        fail("drift: " + ", ".join(drift))
    print("import-rules: %d source(s), %s" % (len(planned), "in sync" if check else "done"))


main(sys.argv[1:])
PYEOF
