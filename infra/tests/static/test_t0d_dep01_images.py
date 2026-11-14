"""T0D-DEP-01 tests (tester role): runnable images + names-only env template. Python standard library only,
no PyYAML, no docker daemon. Covers REQ-SEC-130, CV s1.1 (base image by digest), C0 02-TRD s1.1 row 0D,
02-TRD s11 (config keys), LD-173.

Files under test (the writer creates them; every real-file test FAILS while they are missing):
  services/api/Dockerfile  services/worker/Dockerfile  apps/web/Dockerfile  .dockerignore  .env.example
  .gitignore (line `!.env.example`)  render.yaml  .orchestra/notes/T0D-DEP-01-answers.md

CONTRACTS the writer must meet (tester's reading where the brief is silent):
 * Dockerfile: `ARG NODE_BASE_IMAGE` (no `=`) before the first FROM, a comment directly above it containing
   `imagetools inspect`; every FROM is `FROM [--flag] ${NODE_BASE_IMAGE} [AS name]` (or $NODE_BASE_IMAGE);
   >= 2 stages; no literal `sha256:<64 hex>` digest and no `node:<tag>`; every `pnpm install` has --frozen-lockfile;
   pnpm version, if named (`pnpm@X`), equals root package.json packageManager (else `corepack enable` + COPY package.json);
   final stage: pnpm install/deploy lines carry --prod/--production, `COPY --from=<stage>` of node_modules or a whole
   dir only from a stage whose installs are --prod; last USER of the final stage is numeric and not 0; no docker.sock
   anywhere; final stage never COPYs .env*, *.pem, *.key, *.age, .git, spec, .orchestra; a comment names the writable
   paths and says they are under /tmp (words `read-only` and `/tmp`); every comment line with `writable` has `/tmp`;
   VOLUME only under /tmp.
   API/worker: CMD/ENTRYPOINT runs `node ... src/main.ts`; API `EXPOSE 8080`. Web: `next start` (or `server.js` only if
   next.config.mjs has `output: 'standalone'`), `EXPOSE <port>` and a comment that contains that port number.
 * .dockerignore: lines exactly (trailing `/` ok): .git .orchestra spec **/node_modules **/.next test-results .tmp
   .env* *.pem *.key *.age; no `!` line re-including a secret; nothing that the build needs (package.json,
   pnpm-lock.yaml, services, apps, packages) is ignored.
 * .env.example: every non-comment, non-blank line is exactly `NAME=`; section header comments `# ===== api =====`,
   `# ===== worker =====`, `# ===== web =====` (divider chars = or -, then the word) in this order, each with names;
   the comment block directly above each name (no blank line between) says `required` or `optional` and names the
   LIMS_CORE_ENV values (dev|ci|staging|production) or `all`; no duplicate name in a group; the api group lists every
   LIMS_* token that config.ts reads in code (comments ignored); worker group has LIMS_CORE_WORKER_DATABASE_URL; web
   group has LIMS_ORIGIN_API and LIMS_WEB_BFF_KEY_FILE; every name is read by a tracked non-test source file.
 * .gitignore: line `!.env.example` after `.env.*`; `git check-ignore --no-index`: .env.example not ignored, .env and
   .env.local ignored.
 * render.yaml: first non-blank line is a comment with `host-specific` and `deleted`; one top-level key `services`
   with one item: type web, name lims-api, runtime docker, dockerfilePath (./)services/api/Dockerfile, dockerContext
   `.`, plan free; block-style envVars (`- key: X` then `value:` or `sync: false`). Only LIMS_CORE_ENV=staging,
   LIMS_CORE_DB_POOL_MAX=5, PORT=8080 may have `value`; all others `sync: false` and nothing else; NODE_BASE_IMAGE and
   LIMS_CORE_DATABASE_URL present; every other key (not NODE_BASE_IMAGE, PORT) is listed in .env.example.
 * answers.md: cites >= 10 `path:line` references, every one resolving to an existing tracked file and an existing line;
   mentions the four JWT names, LIMS_CORE_STORAGE_URL, LIMS_CORE_STORAGE_KEY_FILE, 8080, db/bootstrap,
   identity:bootstrap-platform-admin and what happens when Storage is unset.
Planted-failure tests run the same validators on synthetic text and must be rejected for the stated reason.
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t0d_dep01_images.py" -v
"""
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_DF = ROOT / "services" / "api" / "Dockerfile"
WORKER_DF = ROOT / "services" / "worker" / "Dockerfile"
WEB_DF = ROOT / "apps" / "web" / "Dockerfile"
DOCKERIGNORE = ROOT / ".dockerignore"
ENV_EXAMPLE = ROOT / ".env.example"
GITIGNORE = ROOT / ".gitignore"
RENDER = ROOT / "render.yaml"
ANSWERS = ROOT / ".orchestra" / "notes" / "T0D-DEP-01-answers.md"
CONFIG_TS = ROOT / "services" / "api" / "src" / "core" / "config.ts"
NEXT_CONFIG = ROOT / "apps" / "web" / "next.config.mjs"


def read(path):
    return Path(path).read_text(encoding="utf-8")


def pnpm_version():
    pm = json.loads(read(ROOT / "package.json"))["packageManager"]
    m = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)", pm)
    assert m, pm
    return m.group(1)


def git(*args, cwd=ROOT):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)


# ---------------------------------------------------------------- Dockerfile validator
PROD_RE = re.compile(r"(--prod(uction)?\b|\s-P\b)")
FROM_RE = re.compile(r"^FROM\s+(?:--\S+\s+)*\$\{?NODE_BASE_IMAGE\}?(?:\s+AS\s+(\S+))?\s*$", re.I)
SECRET_SRC = re.compile(r"(^|/)(\.env[^/]*|[^/]*\.pem|[^/]*\.key|[^/]*\.age|\.git|spec|\.orchestra)(/|$)", re.I)


def parse_dockerfile(text):
    """-> (instructions [(lineno, KEYWORD, rest)], comments [(lineno, text)]); continuation lines joined."""
    instr, comments, buf, start = [], [], "", 0
    for no, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not buf and line.startswith("#"):
            comments.append((no, line))
            continue
        if not line and not buf:
            continue
        if not buf:
            start = no
        if line.endswith("\\"):
            buf += line[:-1] + " "
            continue
        buf += line
        kw, _, rest = buf.partition(" ")
        instr.append((start, kw.upper(), rest.strip()))
        buf = ""
    return instr, comments


def stages_of(instr):
    """-> list of dict(name, from_line, items) ; items = [(lineno, KW, rest)] after the FROM."""
    out = []
    for no, kw, rest in instr:
        if kw == "FROM":
            m = FROM_RE.match("FROM " + rest)
            out.append({"name": (m.group(1) if m and m.group(1) else None), "from": rest, "no": no, "items": []})
        elif out:
            out[-1]["items"].append((no, kw, rest))
    return out


def cmd_text(rest):
    return " ".join(re.sub(r"[\[\]\",]", " ", rest).split())


def copy_parts(rest):
    flags = dict(re.findall(r"--(\w+)=(\S+)", rest))
    toks = [t for t in rest.split() if not t.startswith("--")]
    return flags, toks[:-1], toks[-1:] if toks else []


def check_dockerfile(text, kind, pm_version):
    """kind: api | worker | web. Returns list of error strings (empty = ok)."""
    e = []
    instr, comments = parse_dockerfile(text)
    stages = stages_of(instr)
    if not stages:
        return ["no FROM"]
    if len(stages) < 2:
        e.append("not multi-stage (need >= 2 FROM)")
    # ARG NODE_BASE_IMAGE (no default) before first FROM, comment above mentions imagetools inspect
    first_from = stages[0]["no"]
    args = [(no, rest) for no, kw, rest in instr if kw == "ARG" and rest.split("=")[0].strip() == "NODE_BASE_IMAGE"]
    if not any(no < first_from and "=" not in rest for no, rest in args):
        e.append("ARG NODE_BASE_IMAGE without default must precede the first FROM")
    if any("=" in rest for _, rest in args):
        e.append("ARG NODE_BASE_IMAGE must have NO default")
    arg_no = min((no for no, rest in args if no < first_from), default=None)
    if arg_no is not None:
        block, n = [], arg_no - 1
        lines = text.splitlines()
        while n >= 1 and lines[n - 1].strip().startswith("#"):
            block.append(lines[n - 1])
            n -= 1
        if "imagetools inspect" not in " ".join(block).lower():
            e.append("comment directly above ARG NODE_BASE_IMAGE must say the digest is read with docker buildx imagetools inspect")
    for st in stages:
        if not FROM_RE.match("FROM " + st["from"]):
            e.append(f"FROM must use ${{NODE_BASE_IMAGE}}: FROM {st['from']}")
    if re.search(r"sha256:[0-9a-f]{64}", text) or re.search(r"(?im)^\s*FROM\s+(\S+/)?node[:@\s]", text):
        e.append("literal digest or node tag written in the Dockerfile")
    if "docker.sock" in text:
        e.append("docker.sock referenced")
    # pnpm
    for line_no, kw, rest in instr:
        if kw == "RUN" and re.search(r"\bpnpm\s+(install|i)\b", rest) and "--frozen-lockfile" not in rest:
            e.append(f"line {line_no}: pnpm install without --frozen-lockfile")
    if "--frozen-lockfile" not in text:
        e.append("--frozen-lockfile never used")
    versions = set(re.findall(r"pnpm@(\d+\.\d+\.\d+)", text))
    if versions - {pm_version}:
        e.append(f"pnpm version {sorted(versions - {pm_version})} differs from packageManager {pm_version}")
    if not versions and not ("corepack enable" in text and re.search(r"(?m)^\s*COPY\s+.*package\.json", text)):
        e.append("pnpm version not taken from packageManager (pnpm@<version> or corepack enable + COPY package.json)")
    if "pnpm-lock.yaml" not in text:
        e.append("pnpm-lock.yaml not copied")
    # ENV / ARG must not set secret-looking values
    for no, kw, rest in instr:
        if kw in ("ENV", "ARG"):
            m = re.match(r"(\w+)[= ]\s*(\S+)", rest)
            if m and re.search(r"(SECRET|PASSWORD|TOKEN|KEY|DATABASE_URL|_URL$)", m.group(1)) and m.group(2).strip("\"'"):
                e.append(f"line {no}: {kw} {m.group(1)} carries a value")
        if kw == "ADD" and re.match(r"https?://", rest):
            e.append(f"line {no}: ADD from URL")
        if kw == "VOLUME" and any(not v.startswith("/tmp") for v in re.findall(r"[/\w.-]+", rest)):
            e.append(f"line {no}: VOLUME outside /tmp")
    # final stage
    fin = stages[-1]
    by_name = {s["name"]: s for s in stages if s["name"]}
    users = [rest for _, kw, rest in fin["items"] if kw == "USER"]
    if not users:
        e.append("final stage has no USER")
    else:
        u = users[-1].split(":")[0]
        if not re.fullmatch(r"\d+", u) or int(u) == 0:
            e.append(f"final USER must be numeric and non-root, got {users[-1]!r}")
    for no, kw, rest in fin["items"]:
        if kw == "RUN" and re.search(r"\bpnpm\s+(install|i|deploy)\b", rest) and not PROD_RE.search(" " + rest):
            e.append(f"line {no}: final stage installs without --prod")
        if kw in ("COPY", "ADD"):
            flags, srcs, _ = copy_parts(rest)
            for s in srcs:
                s2 = s.strip("\"'")
                s2 = s2[2:] if s2.startswith("./") else s2
                if SECRET_SRC.search(s2) or s2 in (".git", ".env", "spec", ".orchestra"):
                    e.append(f"line {no}: final stage COPY of {s}")
                if "from" not in flags and "node_modules" in s:
                    e.append(f"line {no}: final stage COPY of host node_modules")
            src_stage = by_name.get(flags.get("from"))
            if src_stage and any(("node_modules" in s) or s.rstrip("/") in ("/app", "", "/") for s in srcs):
                for n2, k2, r2 in src_stage["items"]:
                    if k2 == "RUN" and re.search(r"\bpnpm\s+(install|i|deploy)\b", r2) and not PROD_RE.search(" " + r2):
                        e.append(f"line {no}: copies from stage {flags['from']} that installs dev dependencies (line {n2})")
    if not PROD_RE.search(text):
        e.append("no --prod install/deploy anywhere: final stage must hold production dependencies only")
    # read-only rootfs
    low = text.lower()
    if "read-only" not in low or "/tmp" not in text:
        e.append("comment naming writable paths under /tmp for the read-only root filesystem (REQ-SEC-130) missing")
    for no, c in comments:
        if "writable" in c.lower() and "/tmp" not in c:
            e.append(f"line {no}: writable path comment without /tmp")
    # kind specific
    final_text = " ".join(cmd_text(r) for _, kw, r in fin["items"] if kw in ("CMD", "ENTRYPOINT"))
    if kind in ("api", "worker"):
        if not re.search(r"\bnode\b.*\bsrc/main\.ts\b", final_text):
            e.append(f"CMD/ENTRYPOINT must run node src/main.ts, got {final_text!r}")
        if re.search(r"\b(tsx|ts-node|nodemon)\b", final_text):
            e.append("API/worker have no build step: no tsx/ts-node")
    exposes = [r for _, kw, r in fin["items"] if kw == "EXPOSE"]
    if kind == "api" and not any(re.search(r"(^|\s)8080(/tcp)?(\s|$)", x) for x in exposes):
        e.append("API image must EXPOSE 8080")
    if kind == "web":
        standalone = NEXT_CONFIG.exists() and re.search(r"output\s*:\s*['\"]standalone['\"]", read(NEXT_CONFIG))
        if not (re.search(r"\bnext start\b", final_text) or (standalone and "server.js" in final_text)):
            e.append("web CMD must run `next start` (server.js only with output: 'standalone' in next.config.mjs)")
        if "next dev" in text or re.search(r"next dev", final_text):
            e.append("web image must not run next dev")
        ports = [p for x in exposes for p in re.findall(r"\d+", x)]
        if not ports:
            e.append("web image must EXPOSE its port")
        elif not any(p in c for p in ports for _, c in comments):
            e.append("web port must be documented in a comment")
        if not re.search(r"\bbuild\b", text):
            e.append("web image never builds")
    return e


# ---------------------------------------------------------------- .dockerignore validator
REQUIRED_IGNORE = [".git", ".orchestra", "spec", "**/node_modules", "**/.next", "test-results", ".tmp", ".env*",
                   "*.pem", "*.key", "*.age"]
NEEDED_BY_BUILD = {"package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "services", "apps", "packages", "contracts",
                   "tsconfig.base.json", "services/api", "services/worker", "apps/web"}


def check_dockerignore(text):
    e = []
    lines = [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.strip().startswith("#")]
    norm = {ln.rstrip("/") for ln in lines}
    for req in REQUIRED_IGNORE:
        ok = req in norm or ("/" + req) in norm if not req.startswith("**/") else req in norm
        if not ok:
            e.append(f"missing {req}")
    for ln in lines:
        if ln.startswith("!") and re.search(r"(\.env|\.pem|\.key|\.age|\.git|spec|\.orchestra)", ln):
            e.append(f"negation re-includes a secret path: {ln}")
    for need in NEEDED_BY_BUILD:
        if need in norm or "/" + need in norm:
            e.append(f"ignores a path the build needs: {need}")
    return e


# ---------------------------------------------------------------- .env.example validator
HEADER_RE = re.compile(r"^#\s*[=\-]{3,}\s*(api|worker|web)\b", re.I)
NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*=$")
ENV_WORD_RE = re.compile(r"\b(dev|ci|staging|production|all)\b", re.I)


def config_ts_names(ts_text):
    """LIMS_* tokens read in code (comments stripped)."""
    code = re.sub(r"/\*.*?\*/", "", ts_text, flags=re.S)
    code = re.sub(r"//[^\n]*", "", code)
    return set(re.findall(r"\bLIMS_[A-Z0-9_]+\b", code))


def parse_env_example(text):
    """-> (errors, groups {name: [var,...]}, all_names)"""
    e, groups, cur, all_names = [], {}, None, []
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if not ln.strip():
            continue
        if ln.startswith("#"):
            m = HEADER_RE.match(ln)
            if m:
                cur = m.group(1).lower()
                if cur in groups:
                    e.append(f"duplicate section {cur}")
                groups.setdefault(cur, [])
            continue
        if not NAME_RE.match(ln):
            e.append(f"line {i + 1}: must be exactly NAME= with nothing after '=', got {ln!r}")
            continue
        name = ln[:-1]
        if cur is None:
            e.append(f"line {i + 1}: {name} before any section header")
            continue
        if name in groups[cur]:
            e.append(f"line {i + 1}: duplicate {name} in group {cur}")
        groups[cur].append(name)
        all_names.append(name)
        block, j = [], i - 1
        while j >= 0 and lines[j].startswith("#") and not HEADER_RE.match(lines[j]):
            block.append(lines[j])
            j -= 1
        b = " ".join(block)
        if not re.search(r"\b(required|optional)\b", b, re.I) or not ENV_WORD_RE.search(b):
            e.append(f"line {i + 1}: {name} needs a comment directly above with required|optional and LIMS_CORE_ENV values")
    return e, groups, all_names


def check_env_example(text, config_names, source_names):
    e, groups, all_names = parse_env_example(text)
    order = list(groups)
    if order != ["api", "worker", "web"]:
        e.append(f"sections must be api, worker, web in order; got {order}")
    for g in ("api", "worker", "web"):
        if not groups.get(g):
            e.append(f"section {g} is empty or missing")
    missing = sorted(set(config_names) - set(groups.get("api", [])))
    if missing:
        e.append(f"api group lacks names config.ts reads: {missing}")
    if "LIMS_CORE_WORKER_DATABASE_URL" not in groups.get("worker", []):
        e.append("worker group lacks LIMS_CORE_WORKER_DATABASE_URL")
    for n in ("LIMS_ORIGIN_API", "LIMS_WEB_BFF_KEY_FILE"):
        if n not in groups.get("web", []):
            e.append(f"web group lacks {n}")
    unread = sorted(set(all_names) - set(source_names))
    if unread:
        e.append(f"names not read by any tracked source file: {unread}")
    return e


def tracked_source_names(names):
    """Subset of names that appear (whole word) in tracked non-test source files."""
    if not names:
        return set()
    pat = r"\b(" + "|".join(sorted(re.escape(n) for n in names)) + r")\b"
    r = git("grep", "-ohE", pat, "--", "*.ts", "*.tsx", "*.mjs", "*.js", "*.cjs", "*.mts",
            ":!spec", ":!docs", ":!tests", ":!*__tests__*", ":!*.test.*", ":!*.spec.*", ":!*/tests/*", ":!*/test/*")
    return set(r.stdout.split())


def check_gitignore_via_git(repo):
    """repo = dir with .gitignore. -> errors."""
    e = []
    def ign(p):
        return git("check-ignore", "-q", "--no-index", "--", p, cwd=repo).returncode == 0
    if ign(".env.example"):
        e.append(".env.example is ignored")
    for p in (".env", ".env.local"):
        if not ign(p):
            e.append(f"{p} is not ignored")
    return e


# ---------------------------------------------------------------- render.yaml validator
LITERALS = {"LIMS_CORE_ENV": "staging", "LIMS_CORE_DB_POOL_MAX": "5", "PORT": "8080"}


def _val(s):
    s = re.sub(r"\s+#.*$", "", s.strip())
    return s.strip("\"'")


def parse_render(text):
    """Minimal block-YAML reader for the render.yaml shape. -> (errors, top_keys, services[list of dict with envVars list])"""
    e, top, services = [], [], []
    lines = [(i, ln.rstrip()) for i, ln in enumerate(text.splitlines(), 1) if ln.strip() and not ln.strip().startswith("#")]
    cur_items = None
    for i, ln in lines:
        if not ln.startswith(" ") and not ln.startswith("-"):
            top.append(ln.split(":")[0])
    try:
        idx = next(n for n, (_, ln) in enumerate(lines) if ln.startswith("services:"))
    except StopIteration:
        return ["no top-level services:"], top, []
    body = [ln for _, ln in lines[idx + 1:] if True]
    # stop at the next top-level key
    cut = []
    for ln in body:
        if ln and not ln.startswith(" ") and not ln.startswith("-"):
            break
        cut.append(ln)
    if not cut:
        return ["services: is empty"], top, []
    base = len(cut[0]) - len(cut[0].lstrip())
    if not cut[0].lstrip().startswith("- "):
        return ["services items must be block list items"], top, []
    items = []
    for ln in cut:
        ind = len(ln) - len(ln.lstrip())
        if ind == base and ln.lstrip().startswith("- "):
            items.append([])
        items[-1].append(ln)
    for it in items:
        svc, envs, in_env, env_ind, curenv = {}, [], False, None, None
        for n, ln in enumerate(it):
            s = ln.lstrip()
            ind = len(ln) - len(s)
            if n == 0:
                s = s[2:]
                ind += 2
            if in_env and ind <= env_ind:
                in_env = False
            if in_env:
                if s.startswith("- "):
                    curenv = {}
                    envs.append(curenv)
                    s = s[2:]
                if ":" in s and curenv is not None:
                    k, _, v = s.partition(":")
                    curenv[k.strip()] = _val(v)
                continue
            if s.startswith("envVars:"):
                in_env, env_ind = True, ind
                continue
            if ":" in s and ind == base + 2:
                k, _, v = s.partition(":")
                svc[k.strip()] = _val(v)
        svc["envVars"] = envs
        services.append(svc)
    return e, top, services


def check_render(text, env_example_names):
    e = []
    nonblank = [ln for ln in text.splitlines() if ln.strip()]
    if not nonblank or not nonblank[0].startswith("#") or not (
            "host-specific" in nonblank[0].lower() or "host-specific" in " ".join(
                ln for ln in text.splitlines()[:5] if ln.startswith("#")).lower()):
        e.append("file must start with a comment saying it is host-specific")
    head = " ".join(ln for ln in text.splitlines()[:6] if ln.startswith("#")).lower()
    if "deleted" not in head:
        e.append("opening comment must say the file may be deleted")
    perr, top, services = parse_render(text)
    e += perr
    if top and top != ["services"]:
        e.append(f"only a services: key is allowed, got {top}")
    if len(services) != 1:
        e.append(f"exactly one service required, got {len(services)}")
        return e
    s = services[0]
    for k, v in (("type", "web"), ("name", "lims-api"), ("runtime", "docker"), ("plan", "free")):
        if s.get(k) != v:
            e.append(f"service {k} must be {v}, got {s.get(k)!r}")
    if s.get("region") != "singapore":
        e.append(f"region must be singapore (LD-175 pt 2), got {s.get('region')!r}")
    if "healthCheckPath" in s:
        e.append("healthCheckPath must not be set: /health/live is on LIMS_CORE_METRICS_PORT, not 8080 (LD-175 pt 2)")
    if s.get("dockerfilePath", "").lstrip("./") != "services/api/Dockerfile":
        e.append(f"dockerfilePath must be services/api/Dockerfile, got {s.get('dockerfilePath')!r}")
    if s.get("dockerContext") not in (".", "./"):
        e.append(f"dockerContext must be the repo root '.', got {s.get('dockerContext')!r}")
    keys = [v.get("key") for v in s["envVars"]]
    if len(keys) != len(set(keys)):
        e.append("duplicate env var keys")
    for v in s["envVars"]:
        k = v.get("key")
        if k in LITERALS:
            if v.get("value") != LITERALS[k]:
                e.append(f"{k} must be the literal {LITERALS[k]!r}, got {v.get('value')!r}")
            if v.get("sync") == "false":
                e.append(f"{k} is a literal, not sync: false")
        else:
            extra = set(v) - {"key", "sync"}
            if v.get("sync") != "false":
                e.append(f"{k} must be sync: false")
            if extra:
                e.append(f"{k} carries {sorted(extra)}: only sync: false allowed (no value, generateValue, from*)")
            if k not in ("NODE_BASE_IMAGE",) and k not in env_example_names:
                e.append(f"{k} is not listed in .env.example")
    for k in LITERALS:
        if k not in keys:
            e.append(f"missing literal env var {k}")
    for k in ("NODE_BASE_IMAGE", "LIMS_CORE_DATABASE_URL"):
        if k not in keys:
            e.append(f"missing env var {k} (sync: false)")
    return e


# ---------------------------------------------------------------- pg runtime dependency (LD-175 pt 1)
def check_pg(pkg_text, lock_text):
    e = []
    pkg = json.loads(pkg_text)
    deps, dev = pkg.get("dependencies", {}), pkg.get("devDependencies", {})
    if deps.get("pg") != "8.23.1":
        e.append(f"pg must be in dependencies of services/api at exactly 8.23.1, got {deps.get('pg')!r}")
    if "pg" in dev:
        e.append("pg must not stay in devDependencies of services/api")
    if dev.get("@types/pg") != "8.23.1":
        e.append("@types/pg must stay in devDependencies at 8.23.1")
    m = re.search(r"^  services/api:\n(.*?)(?=^  \S|\Z)", lock_text, re.S | re.M)
    if not m:
        return e + ["pnpm-lock.yaml has no services/api importer"]
    sect = re.split(r"^    devDependencies:\n", m.group(1), flags=re.M)
    prod = sect[0]
    devsec = sect[1] if len(sect) > 1 else ""
    if not re.search(r"^      pg:\n        specifier: 8\.23\.1\n", prod, re.M):
        e.append("pnpm-lock.yaml services/api importer: pg not under dependencies at 8.23.1")
    if re.search(r"^      pg:\n", devsec, re.M):
        e.append("pnpm-lock.yaml services/api importer: pg still under devDependencies")
    if not re.search(r"^      '@types/pg':\n", devsec, re.M):
        e.append("pnpm-lock.yaml services/api importer: @types/pg must stay under devDependencies")
    return e


# ---------------------------------------------------------------- answers validator
CITE_RE = re.compile(r"((?:[\w.-]+/)*(?:[\w.-]+\.(?:ts|tsx|mjs|js|cjs|md|yml|yaml|json|sql|sh|py|cmd)|Dockerfile)):(\d+)(?:-(\d+))?")
ANSWER_TOKENS = ["LIMS_CORE_JWT_ALG", "LIMS_CORE_JWT_ISSUER", "LIMS_CORE_JWT_AUDIENCE", "LIMS_CORE_JWT_KEY_FILE",
                 "LIMS_CORE_STORAGE_URL", "LIMS_CORE_STORAGE_KEY_FILE", "8080", "db/bootstrap",
                 "identity:bootstrap-platform-admin"]


def check_answers(text, root=ROOT):
    e = []
    for t in ANSWER_TOKENS:
        if t not in text:
            e.append(f"answers do not mention {t}")
    if not re.search(r"\b(unset|not set|missing|absent)\b", text, re.I):
        e.append("answers do not say what happens at boot when Storage is unset")
    cites = CITE_RE.findall(text)
    if len(cites) < 10:
        e.append(f"need >= 10 file:line citations, found {len(cites)}")
    for path, a, b in cites:
        p = Path(root) / path
        if not p.is_file():
            # citations may be repo-relative to a spec dir; accept a unique tracked file by that relative path
            e.append(f"cited file does not exist: {path}")
            continue
        n = len(p.read_text(encoding="utf-8", errors="replace").splitlines())
        if int(a) < 1 or int(a) > n or (b and (int(b) < int(a) or int(b) > n)):
            e.append(f"cited line out of range: {path}:{a}{'-' + b if b else ''} (file has {n} lines)")
    return e


# ---------------------------------------------------------------- synthetic good samples (validator self-tests)
def good_dockerfile(kind):
    v = pnpm_version()
    base = f"""# syntax=docker/dockerfile:1
# Base image: Node patch pinned by digest (CV s1.1). Read the digest with: docker buildx imagetools inspect <image>
ARG NODE_BASE_IMAGE
FROM ${{NODE_BASE_IMAGE}} AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@{v} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY services/api/package.json services/api/package.json
RUN pnpm install --frozen-lockfile --prod
FROM ${{NODE_BASE_IMAGE}} AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@{v} --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/web ./apps/web
RUN pnpm --dir apps/web build
FROM ${{NODE_BASE_IMAGE}} AS final
# Read-only root filesystem (REQ-SEC-130). The only writable paths are /tmp (scratch) and /tmp/next-cache.
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY services/api/src ./src
USER 10001:10001
"""
    if kind == "api":
        return base + 'EXPOSE 8080\nCMD ["node", "src/main.ts"]\n'
    if kind == "worker":
        return base + 'CMD ["node", "src/main.ts"]\n'
    return base + '# Web listens on port 3000.\nEXPOSE 3000\nCMD ["pnpm", "--dir", "apps/web", "exec", "next", "start", "-p", "3000"]\n'


GOOD_ENV = """# ===== api =====
# required in staging, production; optional in dev, ci.
LIMS_CORE_ENV=
# optional, all environments.
LIMS_CORE_LOG_LEVEL=
# ===== worker =====
# required, all environments.
LIMS_CORE_WORKER_DATABASE_URL=
# ===== web =====
# required in staging, production.
LIMS_ORIGIN_API=
# required in staging, production.
LIMS_WEB_BFF_KEY_FILE=
"""

GOOD_RENDER = """# Render blueprint: host-specific to Render, throwaway, may be deleted.
services:
  - type: web
    name: lims-api
    runtime: docker
    dockerfilePath: ./services/api/Dockerfile
    dockerContext: .
    plan: free
    region: singapore
    envVars:
      - key: NODE_BASE_IMAGE
        sync: false
      - key: LIMS_CORE_ENV
        value: staging
      - key: LIMS_CORE_DB_POOL_MAX
        value: "5"
      - key: PORT
        value: "8080"
      - key: LIMS_CORE_DATABASE_URL
        sync: false
      - key: LIMS_CORE_JWT_KEY_FILE
        sync: false
"""
GOOD_RENDER_NAMES = {"LIMS_CORE_ENV", "LIMS_CORE_DB_POOL_MAX", "LIMS_CORE_DATABASE_URL", "LIMS_CORE_JWT_KEY_FILE"}

GOOD_IGNORE = "\n".join([".git", ".orchestra", "spec", "**/node_modules", "**/.next", "test-results", ".tmp", ".env*",
                         "*.pem", "*.key", "*.age", ""])


# ================================================================ REAL FILE TESTS
class RealDockerfiles(unittest.TestCase):
    def _check(self, path, kind):
        self.assertTrue(path.is_file(), f"{path.relative_to(ROOT)} does not exist")
        errs = check_dockerfile(read(path), kind, pnpm_version())
        self.assertEqual(errs, [], "\n".join(errs))

    def test_api_dockerfile(self):
        self._check(API_DF, "api")

    def test_worker_dockerfile(self):
        self._check(WORKER_DF, "worker")

    def test_web_dockerfile(self):
        self._check(WEB_DF, "web")

    def test_entrypoints_exist_in_tracked_source(self):
        for rel in ("services/api/src/main.ts", "services/worker/src/main.ts"):
            self.assertTrue((ROOT / rel).is_file(), rel)

    def test_api_listens_on_8080_as_main_ts_says(self):
        self.assertIn("port: 8080", read(ROOT / "services" / "api" / "src" / "main.ts"))


class RealDockerignore(unittest.TestCase):
    def test_dockerignore(self):
        self.assertTrue(DOCKERIGNORE.is_file(), ".dockerignore does not exist")
        errs = check_dockerignore(read(DOCKERIGNORE))
        self.assertEqual(errs, [], "\n".join(errs))


class RealEnvExample(unittest.TestCase):
    def test_env_example(self):
        self.assertTrue(ENV_EXAMPLE.is_file(), ".env.example does not exist")
        text = read(ENV_EXAMPLE)
        _, _, names = parse_env_example(text)
        errs = check_env_example(text, config_ts_names(read(CONFIG_TS)), tracked_source_names(names))
        self.assertEqual(errs, [], "\n".join(errs))

    def test_config_ts_names_sanity(self):
        names = config_ts_names(read(CONFIG_TS))
        for n in ("LIMS_CORE_ENV", "LIMS_CORE_DATABASE_URL", "LIMS_CORE_JWT_KEY_FILE", "LIMS_WEB_BFF_KEY_FILE",
                  "LIMS_CORE_TENANT_BURST"):
            self.assertIn(n, names)
        self.assertNotIn("LIMS_CORE_BFF_KEY_FILES", names)  # appears only in a comment

    def test_gitignore_has_negation_after_env_star(self):
        lines = read(GITIGNORE).splitlines()
        self.assertIn("!.env.example", lines)
        self.assertIn(".env.*", lines)
        self.assertGreater(lines.index("!.env.example"), lines.index(".env.*"))

    def test_git_check_ignore_real_repo(self):
        errs = check_gitignore_via_git(ROOT)
        self.assertEqual(errs, [], "\n".join(errs))


class RealRender(unittest.TestCase):
    def test_render_yaml(self):
        self.assertTrue(RENDER.is_file(), "render.yaml does not exist")
        names = set(parse_env_example(read(ENV_EXAMPLE))[2]) if ENV_EXAMPLE.is_file() else set()
        errs = check_render(read(RENDER), names)
        self.assertEqual(errs, [], "\n".join(errs))


class RealPgDependency(unittest.TestCase):
    def test_pg_runtime_dependency(self):
        errs = check_pg(read(ROOT / "services" / "api" / "package.json"), read(ROOT / "pnpm-lock.yaml"))
        self.assertEqual(errs, [], "\n".join(errs))


class RealAnswers(unittest.TestCase):
    def test_answers_file(self):
        self.assertTrue(ANSWERS.is_file(), "T0D-DEP-01-answers.md does not exist")
        errs = check_answers(read(ANSWERS))
        self.assertEqual(errs, [], "\n".join(errs))


# ================================================================ VALIDATOR SELF-TESTS + PLANTED FAILURES
def _has(errs, needle):
    return any(needle.lower() in x.lower() for x in errs)


class GoodSamplesPass(unittest.TestCase):
    def test_good_dockerfiles(self):
        for kind in ("api", "worker", "web"):
            self.assertEqual(check_dockerfile(good_dockerfile(kind), kind, pnpm_version()), [], kind)

    def test_good_ignore_env_render(self):
        self.assertEqual(check_dockerignore(GOOD_IGNORE), [])
        self.assertEqual(parse_env_example(GOOD_ENV)[0], [])
        self.assertEqual(check_render(GOOD_RENDER, GOOD_RENDER_NAMES), [])


class PlantedDockerfileFailures(unittest.TestCase):
    def rej(self, kind, mutate, needle):
        errs = check_dockerfile(mutate(good_dockerfile(kind)), kind, pnpm_version())
        self.assertTrue(_has(errs, needle), f"expected {needle!r} in {errs}")

    def test_tag_only_from(self):
        self.rej("api", lambda t: t.replace("FROM ${NODE_BASE_IMAGE} AS final", "FROM node:26 AS final"), "NODE_BASE_IMAGE")

    def test_tag_only_from_literal_tag_flagged(self):
        self.rej("api", lambda t: t.replace("FROM ${NODE_BASE_IMAGE} AS deps", "FROM node:26.13.0 AS deps"), "node tag")

    def test_arg_with_default(self):
        self.rej("api", lambda t: t.replace("ARG NODE_BASE_IMAGE\n", "ARG NODE_BASE_IMAGE=node:26\n"), "NO default")

    def test_arg_missing(self):
        self.rej("api", lambda t: t.replace("ARG NODE_BASE_IMAGE\n", ""), "ARG NODE_BASE_IMAGE")

    def test_literal_digest(self):
        self.rej("api", lambda t: t + "# " + "sha256:" + "a" * 64 + "\n", "digest")

    def test_missing_imagetools_comment(self):
        self.rej("api", lambda t: t.replace("docker buildx imagetools inspect", "ask the lead"), "imagetools")

    def test_root_user(self):
        self.rej("api", lambda t: t.replace("USER 10001:10001", "USER root"), "numeric")

    def test_user_zero(self):
        self.rej("worker", lambda t: t.replace("USER 10001:10001", "USER 0"), "non-root")

    def test_user_name_not_numeric(self):
        self.rej("api", lambda t: t.replace("USER 10001:10001", "USER node"), "numeric")

    def test_no_user(self):
        self.rej("api", lambda t: t.replace("USER 10001:10001\n", ""), "no USER")

    def test_docker_sock(self):
        self.rej("api", lambda t: t.replace("WORKDIR /app\nCOPY --from=deps", "WORKDIR /app\nVOLUME /var/run/docker.sock\nCOPY --from=deps"), "docker.sock")

    def test_copy_env_file(self):
        self.rej("api", lambda t: t.replace("COPY services/api/src ./src", "COPY .env.production ./.env"), "final stage COPY")

    def test_copy_pem_key_git_spec_orchestra(self):
        for src in ("certs/server.pem", "keys/jwt.key", ".git", "spec", ".orchestra/notes", "x/y.age"):
            self.rej("api", lambda t, s=src: t.replace("COPY services/api/src ./src", f"COPY {s} ./x"), "final stage COPY")

    def test_install_without_frozen_lockfile(self):
        self.rej("api", lambda t: t.replace("pnpm install --frozen-lockfile --prod", "pnpm install --prod"), "frozen-lockfile")

    def test_wrong_pnpm_version(self):
        self.rej("api", lambda t: t.replace(f"pnpm@{pnpm_version()}", "pnpm@9.0.0"), "differs from packageManager")

    def test_final_stage_dev_install(self):
        self.rej("api", lambda t: t + "RUN pnpm install --frozen-lockfile\n", "without --prod")

    def test_final_copies_node_modules_from_dev_stage(self):
        self.rej("api", lambda t: t.replace("COPY --from=deps /app/node_modules", "COPY --from=builder /app/node_modules"), "dev dependencies")

    def test_api_expose_wrong_port(self):
        self.rej("api", lambda t: t.replace("EXPOSE 8080", "EXPOSE 3000"), "EXPOSE 8080")

    def test_api_cmd_not_main_ts(self):
        self.rej("api", lambda t: t.replace('"node", "src/main.ts"', '"npm", "start"'), "src/main.ts")

    def test_worker_cmd_uses_tsx(self):
        self.rej("worker", lambda t: t.replace('"node", "src/main.ts"', '"node", "src/main.ts", "tsx"'), "tsx")

    def test_no_tmp_comment(self):
        self.rej("api", lambda t: t.replace("# Read-only root filesystem (REQ-SEC-130). The only writable paths are /tmp (scratch) and /tmp/next-cache.\n", ""), "/tmp")

    def test_writable_path_outside_tmp(self):
        self.rej("api", lambda t: t + "# writable path: /var/lib/app\n", "without /tmp")

    def test_volume_outside_tmp(self):
        self.rej("api", lambda t: t + "VOLUME /data\n", "VOLUME")

    def test_single_stage(self):
        single = "ARG NODE_BASE_IMAGE\n" + "# imagetools inspect\n"
        errs = check_dockerfile("# imagetools inspect\nARG NODE_BASE_IMAGE\nFROM ${NODE_BASE_IMAGE}\nUSER 1000\n", "api", pnpm_version())
        self.assertTrue(_has(errs, "multi-stage"), errs)

    def test_web_dev_server(self):
        self.rej("web", lambda t: t.replace('"start"', '"dev"'), "next start")

    def test_web_port_undocumented(self):
        self.rej("web", lambda t: t.replace("# Web listens on port 3000.\n", ""), "documented")

    def test_secret_env_value(self):
        self.rej("api", lambda t: t + "ENV LIMS_CORE_DATABASE_URL=postgres://u:p@h/db\n", "carries a value")

    def test_add_url(self):
        self.rej("api", lambda t: t + "ADD https://example.invalid/x.tgz /tmp/x.tgz\n", "ADD from URL")


class PlantedDockerignoreFailures(unittest.TestCase):
    def test_missing_entries(self):
        for req in REQUIRED_IGNORE:
            text = "\n".join(x for x in GOOD_IGNORE.splitlines() if x != req)
            self.assertTrue(_has(check_dockerignore(text), f"missing {req}"), req)

    def test_unanchored_node_modules_rejected(self):
        text = GOOD_IGNORE.replace("**/node_modules", "node_modules")
        self.assertTrue(_has(check_dockerignore(text), "missing **/node_modules"))

    def test_negated_secret(self):
        self.assertTrue(_has(check_dockerignore(GOOD_IGNORE + "!.env.production\n"), "negation"))

    def test_ignores_build_input(self):
        self.assertTrue(_has(check_dockerignore(GOOD_IGNORE + "pnpm-lock.yaml\n"), "build needs"))


class PlantedEnvExampleFailures(unittest.TestCase):
    cfg = {"LIMS_CORE_ENV", "LIMS_CORE_LOG_LEVEL"}
    src = cfg | {"LIMS_CORE_WORKER_DATABASE_URL", "LIMS_ORIGIN_API", "LIMS_WEB_BFF_KEY_FILE"}

    def test_good_passes(self):
        self.assertEqual(check_env_example(GOOD_ENV, self.cfg, self.src), [])

    def test_line_with_value(self):
        errs = check_env_example(GOOD_ENV.replace("LIMS_CORE_LOG_LEVEL=", "LIMS_CORE_LOG_LEVEL=info"), self.cfg, self.src)
        self.assertTrue(_has(errs, "nothing after"), errs)

    def test_line_with_trailing_space_or_export(self):
        for bad in ("LIMS_CORE_LOG_LEVEL= ", "export LIMS_CORE_LOG_LEVEL=", "LIMS_CORE_LOG_LEVEL=''"):
            errs = check_env_example(GOOD_ENV.replace("LIMS_CORE_LOG_LEVEL=", bad), self.cfg, self.src)
            self.assertTrue(_has(errs, "nothing after"), (bad, errs))

    def test_missing_config_name(self):
        errs = check_env_example(GOOD_ENV, self.cfg | {"LIMS_CORE_TENANT_BURST"}, self.src | {"LIMS_CORE_TENANT_BURST"})
        self.assertTrue(_has(errs, "LIMS_CORE_TENANT_BURST"), errs)

    def test_name_not_read_by_source(self):
        errs = check_env_example(GOOD_ENV, self.cfg, self.src - {"LIMS_ORIGIN_API"})
        self.assertTrue(_has(errs, "not read by any tracked source"), errs)

    def test_missing_comment(self):
        errs = check_env_example(GOOD_ENV.replace("# optional, all environments.\n", ""), self.cfg, self.src)
        self.assertTrue(_has(errs, "needs a comment"), errs)

    def test_comment_without_env_values(self):
        errs = check_env_example(GOOD_ENV.replace("# optional, all environments.", "# optional."), self.cfg, self.src)
        self.assertTrue(_has(errs, "needs a comment"), errs)

    def test_wrong_section_order(self):
        text = GOOD_ENV.replace("===== worker =====", "===== web2 =====")
        self.assertTrue(_has(check_env_example(text, self.cfg, self.src), "sections must be"))

    def test_name_before_header(self):
        self.assertTrue(_has(check_env_example("# required, all.\nA=\n" + GOOD_ENV, self.cfg, self.src), "before any section"))

    def test_duplicate_name_in_group(self):
        text = GOOD_ENV.replace("LIMS_CORE_LOG_LEVEL=\n", "LIMS_CORE_LOG_LEVEL=\n# optional, all.\nLIMS_CORE_LOG_LEVEL=\n")
        self.assertTrue(_has(check_env_example(text, self.cfg, self.src), "duplicate"))

    def test_config_ts_comment_names_ignored(self):
        ts = "// LIMS_CORE_FOO in a comment\n/* LIMS_CORE_BAR */\nconst a = env.LIMS_CORE_BAZ; // LIMS_CORE_QUX\n"
        self.assertEqual(config_ts_names(ts), {"LIMS_CORE_BAZ"})


class PlantedGitignoreFailures(unittest.TestCase):
    def _repo(self, gitignore):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.assertEqual(git("init", "-q", cwd=d.name).returncode, 0)
        Path(d.name, ".gitignore").write_text(gitignore, encoding="utf-8")
        return d.name

    def test_good_gitignore(self):
        self.assertEqual(check_gitignore_via_git(self._repo(".env\n.env.*\n!.env.example\n")), [])

    def test_env_example_ignored_without_negation(self):
        errs = check_gitignore_via_git(self._repo(".env\n.env.*\n"))
        self.assertTrue(_has(errs, ".env.example is ignored"), errs)

    def test_negation_before_pattern_does_not_help(self):
        errs = check_gitignore_via_git(self._repo("!.env.example\n.env\n.env.*\n"))
        self.assertTrue(_has(errs, ".env.example is ignored"), errs)

    def test_env_local_not_ignored(self):
        errs = check_gitignore_via_git(self._repo(".env\n"))
        self.assertTrue(_has(errs, ".env.local is not ignored"), errs)


class PlantedRenderFailures(unittest.TestCase):
    def rej(self, mutate, needle):
        errs = check_render(mutate(GOOD_RENDER), GOOD_RENDER_NAMES)
        self.assertTrue(_has(errs, needle), f"expected {needle!r} in {errs}")

    def test_literal_secret(self):
        self.rej(lambda t: t.replace("- key: LIMS_CORE_DATABASE_URL\n        sync: false",
                                     "- key: LIMS_CORE_DATABASE_URL\n        value: postgres://u:p@h/db"), "sync: false")

    def test_literal_secret_with_sync_false_and_value(self):
        self.rej(lambda t: t.replace("- key: LIMS_CORE_JWT_KEY_FILE\n        sync: false",
                                     "- key: LIMS_CORE_JWT_KEY_FILE\n        value: /run/k\n        sync: false"), "only sync: false")

    def test_generate_value(self):
        self.rej(lambda t: t.replace("- key: LIMS_CORE_JWT_KEY_FILE\n        sync: false",
                                     "- key: LIMS_CORE_JWT_KEY_FILE\n        generateValue: true"), "sync: false")

    def test_fourth_literal(self):
        self.rej(lambda t: t + "      - key: LIMS_CORE_LOG_LEVEL\n        value: debug\n", "sync: false")

    def test_wrong_literal_value(self):
        self.rej(lambda t: t.replace('value: "8080"', 'value: "10000"'), "PORT must be the literal")

    def test_missing_port_literal(self):
        self.rej(lambda t: t.replace('      - key: PORT\n        value: "8080"\n', ""), "missing literal env var PORT")

    def test_missing_node_base_image(self):
        self.rej(lambda t: t.replace("      - key: NODE_BASE_IMAGE\n        sync: false\n", ""), "NODE_BASE_IMAGE")

    def test_second_service(self):
        self.rej(lambda t: t + "  - type: worker\n    name: lims-worker\n    runtime: docker\n", "exactly one service")

    def test_extra_top_level_key(self):
        self.rej(lambda t: t + "databases:\n  - name: db\n", "only a services")

    def test_wrong_plan_and_context(self):
        self.rej(lambda t: t.replace("plan: free", "plan: starter"), "plan must be free")
        self.rej(lambda t: t.replace("dockerContext: .", "dockerContext: services/api"), "dockerContext")

    def test_missing_header_comment(self):
        self.rej(lambda t: t.split("\n", 1)[1], "host-specific")

    def test_region_missing_or_wrong(self):
        self.rej(lambda t: t.replace("    region: singapore\n", ""), "region must be singapore")
        self.rej(lambda t: t.replace("region: singapore", "region: oregon"), "region must be singapore")

    def test_health_check_path_rejected(self):
        self.rej(lambda t: t.replace("    plan: free\n", "    plan: free\n    healthCheckPath: /health/live\n"),
                 "healthCheckPath must not be set")

    def test_env_key_not_in_env_example(self):
        errs = check_render(GOOD_RENDER.replace("LIMS_CORE_JWT_KEY_FILE", "LIMS_CORE_MADE_UP"), GOOD_RENDER_NAMES)
        self.assertTrue(_has(errs, "not listed in .env.example"), errs)


GOOD_PKG = json.dumps({"dependencies": {"pg": "8.23.1"}, "devDependencies": {"@types/pg": "8.23.1"}})
GOOD_LOCK = """importers:

  services/api:
    dependencies:
      pg:
        specifier: 8.23.1
        version: 8.23.1
    devDependencies:
      '@types/pg':
        specifier: 8.23.1
        version: 8.23.1
      vitest:
        specifier: 5.1.0
        version: 5.1.0

  services/worker:
    dependencies: {}
"""


class PlantedPgFailures(unittest.TestCase):
    def test_good_passes(self):
        self.assertEqual(check_pg(GOOD_PKG, GOOD_LOCK), [])

    def test_pg_in_devdependencies_package_json(self):
        pkg = json.dumps({"devDependencies": {"@types/pg": "8.23.1", "pg": "8.23.1"}})
        self.assertTrue(_has(check_pg(pkg, GOOD_LOCK), "must be in dependencies"))
        self.assertTrue(_has(check_pg(pkg, GOOD_LOCK), "devDependencies"))

    def test_pg_version_changed(self):
        pkg = json.dumps({"dependencies": {"pg": "8.20.0"}, "devDependencies": {"@types/pg": "8.23.1"}})
        self.assertTrue(_has(check_pg(pkg, GOOD_LOCK), "exactly 8.23.1"))

    def test_types_pg_moved(self):
        pkg = json.dumps({"dependencies": {"pg": "8.23.1", "@types/pg": "8.23.1"}})
        self.assertTrue(_has(check_pg(pkg, GOOD_LOCK), "@types/pg must stay"))

    def test_lock_unchanged(self):
        moved = "      pg:\n        specifier: 8.23.1\n        version: 8.23.1\n"
        bad = GOOD_LOCK.replace("    dependencies:\n" + moved, "    dependencies: {}\n").replace(
            "      vitest:", moved + "      vitest:")
        errs = check_pg(GOOD_PKG, bad)
        self.assertTrue(_has(errs, "not under dependencies"), errs)
        self.assertTrue(_has(errs, "still under devDependencies"), errs)


class PlantedAnswersFailures(unittest.TestCase):
    def test_unresolvable_and_out_of_range_citations(self):
        good = "\n".join(f"- services/api/src/core/config.ts:{n}" for n in (77, 83, 88, 89, 110, 111)) + "\n"
        text = good + " ".join(ANSWER_TOKENS) + " unset " + "services/api/src/main.ts:4 db/bootstrap/README.md:1 package.json:3 package.json:4\n"
        errs_ok = check_answers(text)
        self.assertFalse(_has(errs_ok, "out of range"), errs_ok)
        self.assertTrue(_has(check_answers(text + "services/api/src/core/config.ts:99999\n"), "out of range"))
        self.assertTrue(_has(check_answers(text + "services/api/src/core/nope.ts:3\n"), "does not exist"))

    def test_guessed_answers_without_citations(self):
        self.assertTrue(_has(check_answers("Supabase supplies the JWT. " + " ".join(ANSWER_TOKENS)), "citations"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
