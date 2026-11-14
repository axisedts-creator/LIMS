"""T-11 tests (tester role): Storage volume (vg_storage, XFS, growable) + object replica (15-min rsync, no delete).

Covers 02-TRD s5.3, s9.5, s3 (ops metrics), AC-14.1..14.3, 07-SEC row A3 (ransomware overwrite -> `--ignore-existing`,
no delete), 03-APP-FLOW s233, 06-PLAN row T-11. LD-45: roles must not hard-code host names/IPs (lean and full both pass).

NOT provable here (needs a Linux host, marked in .orchestra/notes/T-11-tests.md): a real `lvextend -r` on a mounted XFS LV
(infra/tests/integration/test_t11_live.py, LIMS_T11_LIVE=1), real rsync over ssh -p 2222 to dr-1, the 200-object monthly
sample (that lives in the T-10 drill). These tests prove the committed artefacts and the script behaviour with a faked
`rsync` (local-copy emulation honouring --ignore-existing / --checksum / --dry-run / --itemize-changes) and a faked `lvextend`.

CONTRACTS where the spec is silent (the writer must meet them; ambiguity -> dispute, not a silent change):
 * infra/ansible/roles/object_replica/files/lims-object-replica.sh (bash). Env (all optional, with production defaults):
   REPLICA_SRC (default /srv/lims/storage/), REPLICA_DEST (default replica@<dr>:/replica/storage/), TEXTFILE_DIR.
   `rsync` is taken from PATH. No other variable may be required. Modes: `sync` (default, no argument) and `verify`.
   - sync: ONE real rsync call: -a, --ignore-existing, --partial, --checksum-choice=xxh128, src with trailing '/', never any
     --delete*/--del/--remove-source-files on ANY call. Lag is sampled with a `--dry-run` rsync (same flags) that lists
     the files not yet on the replica (`--out-format`/`-i`/-v output, paths relative to src); lag = now - mtime of the newest
     such file, 0 if none. After a successful transfer: exit 0 and write $TEXTFILE_DIR/*.prom with
     lims_ops_object_replica_last_success_timestamp_seconds <now> and lims_ops_object_replica_lag_seconds <lag>.
     After a failed transfer (rsync rc != 0): exit != 0, last_success NOT advanced, lag still written (old pending files).
   - verify (nightly full checksum pass): rsync with --checksum and --dry-run (read-only, never repairs/overwrites the
     replica), --itemize-changes; only lines whose flags contain `c` (content differs, file on both sides) are corruption ->
     exit != 0 and the path on stdout/stderr; objects missing on the replica (not yet synced) are NOT corruption (exit 0).
 * infra/ansible/roles/luks_volumes/files/lims-lv-grow.sh <vg>/<lv> <size> : validates the LV spec, then runs
   `lvextend -r -L|-l <size> /dev/<vg>/<lv>` (or vg/lv form) and nothing that unmounts/deactivates. Installed by the role
   tasks as root-owned, not world-writable.
 * object_replica role files: templates/lims-object-replica.timer.j2 (interval from `object_replica_interval_min`),
   lims-object-replica.service(.j2), lims-object-replica-verify.timer(.j2) (nightly, UTC) and
   lims-object-replica-verify.service(.j2) (ExecStart passes `verify`).
Stdlib + jinja2 + PyYAML. Missing file = FAIL (never skip).
Run from repo root: python -B -m unittest discover -s infra/tests/static -p "test_t11_*.py" -v
"""
import os
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

import jinja2
import yaml

ROOT = Path(__file__).resolve().parents[3]
ROLES = ROOT / "infra" / "ansible" / "roles"
REPL = ROLES / "object_replica"
LUKS = ROLES / "luks_volumes"
SCRIPT = REPL / "files" / "lims-object-replica.sh"
GROW = LUKS / "files" / "lims-lv-grow.sh"
SITE = ROOT / "infra" / "ansible" / "playbooks" / "site.yml"
INVS = ROOT / "infra" / "ansible" / "inventories"
OVERRIDE = ROOT / "infra" / "compose" / "supabase" / "override.app.yml"


def _bash():
    for c in (r"C:\Program Files\Git\bin\bash.exe", shutil.which("bash")):
        if c and Path(c).exists():
            return c
    raise AssertionError("bash not found")


def _p(path):
    """Path for bash: MSYS form on Windows (C:\\x -> /c/x)."""
    s = Path(path).as_posix()
    if os.name == "nt" and re.match(r"^[A-Za-z]:/", s):
        s = "/" + s[0].lower() + s[2:]
    return s


def need(path):
    if not Path(path).is_file():
        raise AssertionError("missing file %s" % Path(path).relative_to(ROOT).as_posix())
    return Path(path).read_text(encoding="utf-8")


def role_files(role):
    if not role.is_dir():
        raise AssertionError("missing dir %s" % role.relative_to(ROOT).as_posix())
    files = [p for p in sorted(role.rglob("*")) if p.is_file()]
    if not files:
        raise AssertionError("%s is empty" % role.relative_to(ROOT).as_posix())
    return {p.relative_to(role).as_posix(): p.read_text(encoding="utf-8") for p in files}


def uncommented(text):
    return "\n".join(l for l in text.splitlines() if not l.strip().startswith("#"))


def find_unit(name_re):
    """Contract file names: lims-object-replica[-verify].{service,timer}[.j2]."""
    files = role_files(REPL)
    hits = [k for k in files if re.search(name_re, Path(k).name)]
    if not hits:
        raise AssertionError("object_replica role has no file matching %s" % name_re)
    return files[hits[0]]


def render(text, **ctx):
    return jinja2.Environment(undefined=jinja2.ChainableUndefined, keep_trailing_newline=True).from_string(text).render(**ctx)


# ---------------------------------------------------------------- AC-14.1: volume (static)
class StorageVolumeTest(unittest.TestCase):
    def setUp(self):
        self.d = yaml.safe_load(need(LUKS / "defaults" / "main.yml"))
        self.classes = self.d["luks_volumes_classes"]

    def test_storage_is_xfs_on_vg_storage(self):  # AC-14.1, TRD s5.3
        self.assertEqual(self.classes["storage"], {"vg": "vg_storage", "fs": "xfs"})

    def test_storage_vg_is_separate_from_db_and_every_other_class(self):  # AC-14.1 "separate from root and DB volumes"
        others = [v["vg"] for k, v in self.classes.items() if k != "storage"]
        self.assertNotIn("vg_storage", others)
        self.assertNotEqual(self.classes["storage"]["vg"], self.classes["db"]["vg"])

    def test_app_hosts_have_a_dedicated_storage_disk_in_every_inventory(self):  # not the root disk
        for inv in ("dev", "staging", "prod"):
            groups = yaml.safe_load(need(INVS / inv / "hosts.yml"))["all"]["children"]
            disks_of = {}  # a host may be listed in several groups (dev: one VM); merge its vars
            for g in groups.values():
                for h, hv in ((g or {}).get("hosts") or {}).items():
                    disks_of.setdefault(h, {}).update((hv or {}).get("disks") or {})
            for h in groups["app"]["hosts"]:
                self.assertIn("storage", disks_of[h], "%s/%s: no `storage` disk (AC-14.1)" % (inv, h))
                self.assertIn("/dev/disk/by-id/", disks_of[h]["storage"], "%s/%s: by-id name expected" % (inv, h))

    def test_storage_container_mount_is_the_lv_mount(self):  # Storage file backend lives on the LV
        t = need(OVERRIDE)
        self.assertRegex(t, r"/srv/lims/storage:/var/lib/storage", "Storage must bind the vg_storage mount")
        self.assertIn("/srv/lims/{{ item.key }}", need(LUKS / "tasks" / "main.yml"), "mount point /srv/lims/<disk key>")

    def test_grow_script_is_shipped_and_installed_by_the_role(self):  # AC-14.1 "can be grown online"
        need(GROW)
        t = need(LUKS / "tasks" / "main.yml")
        self.assertIn("lims-lv-grow.sh", t, "role tasks must install the grow helper")
        m = re.search(r"lims-lv-grow\.sh.{0,300}?mode:\s*\"?(0\d{3})", t, re.S)
        self.assertTrue(m, "grow helper needs an explicit mode")
        self.assertNotIn(m.group(1)[-1], "2367", "mode %s is world-writable/other-accessible" % m.group(1))

    def test_grow_script_uses_lvextend_resizefs_and_never_unmounts(self):
        t = uncommented(need(GROW))
        self.assertRegex(t, r"lvextend\s[^\n]*(\s-r\b|\s--resizefs\b)", "lvextend -r (online fs grow)")
        for bad in (r"\bumount\b", r"lvchange\s+-an", r"\bfsck\b", r"mkfs", r"--force|\s-f\s", r"\bshred\b|\bwipefs\b|luksFormat"):
            self.assertNotRegex(t, bad, "grow must be online and non-destructive: " + bad)


# ---------------------------------------------------------------- lvextend -r behaviour with a fake
FAKE_LVEXTEND = "#!/usr/bin/env bash\necho \"lvextend $*\" >> \"$FIX/calls.log\"\nexit ${FAKE_LV_RC:-0}\n"
FAKE_TRACE = "#!/usr/bin/env bash\necho \"$(basename \"$0\") $*\" >> \"$FIX/calls.log\"\nexit 0\n"


class GrowScriptTest(unittest.TestCase):
    def setUp(self):
        need(GROW)
        self.tmp = Path(tempfile.mkdtemp(prefix="t11g-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "lvextend").write_bytes(FAKE_LVEXTEND.encode())
        for n in ("umount", "lvchange", "fsck", "xfs_growfs", "resize2fs", "cryptsetup", "pvresize"):
            (self.bin / n).write_bytes(FAKE_TRACE.encode())

    def run_grow(self, *args, rc=0):
        env = dict(os.environ, FIX=_p(self.tmp), FAKE_LV_RC=str(rc), PATH=_p(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        r = subprocess.run([_bash(), _p(GROW), *args], env=env, capture_output=True, text=True, timeout=60)
        log = (self.tmp / "calls.log").read_text() if (self.tmp / "calls.log").exists() else ""
        return r, log

    def test_storage_lv_extended_online_with_r(self):  # done_when "lvextend -r online"
        r, log = self.run_grow("vg_storage/lv_storage", "+100G")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = [l for l in log.splitlines() if l.startswith("lvextend")]
        self.assertEqual(len(calls), 1, log)
        self.assertRegex(calls[0], r"(\s-r\b|\s--resizefs\b)")
        self.assertIn("+100G", calls[0])
        self.assertRegex(calls[0], r"(/dev/)?vg_storage/lv_storage")
        for bad in ("umount", "lvchange", "fsck"):
            self.assertNotIn(bad, log, "must stay online: " + log)

    def test_percent_free_size_accepted(self):
        r, log = self.run_grow("vg_storage/lv_storage", "+100%FREE")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("+100%FREE", log)

    def test_failed_lvextend_fails_the_script(self):  # no silent success
        r, _ = self.run_grow("vg_storage/lv_storage", "+10G", rc=5)
        self.assertNotEqual(r.returncode, 0)

    def test_bad_input_rejected_without_calling_lvextend(self):  # injection / path traversal at a trust boundary
        for args in ((), ("vg_storage/lv_storage",), ("vg_storage/lv_storage; touch /tmp/x", "+1G"), ("../../etc/passwd", "+1G"),
                     ("vg_storage/lv_storage", "+1G; rm -rf /"), ("vg_storage/lv_storage", "$(id)"), ("vg storage/lv", "+1G"),
                     ("/dev/sda", "+1G"), ("vg_storage/lv_storage", "-10G"), ("vg_storage/lv_storage", "--force")):
            with self.subTest(args=args):
                (self.tmp / "calls.log").unlink(missing_ok=True)
                r, log = self.run_grow(*args)
                self.assertNotEqual(r.returncode, 0, "accepted %r" % (args,))
                self.assertNotIn("lvextend", log, "lvextend called for %r" % (args,))


# ---------------------------------------------------------------- object_replica role (static)
class RoleStaticTest(unittest.TestCase):
    def setUp(self):
        self.files = role_files(REPL)
        self.all = "\n".join(self.files.values())
        self.code = uncommented(self.all)

    def test_script_present(self):
        need(SCRIPT)

    def test_rsync_contract_flags_and_no_delete_anywhere(self):  # TRD s9.5, 07-SEC A3
        t = uncommented(need(SCRIPT))
        for f in ("--ignore-existing", "--partial", "--checksum-choice=xxh128"):
            self.assertIn(f, t)
        self.assertRegex(t, r"((?:^|\s)-[a-zA-Z]*a[a-zA-Z]*\b|--archive)", "rsync -a")
        self.assertNotRegex(self.code, r"--(delete|del\b|remove-source)", "no delete flag, anywhere in the role (AC-14.2)")
        self.assertNotRegex(self.code, r"\bunarchive\b.*delete|state:\s*absent[^\n]*replica", "no deletion task on the replica")

    def test_transport_pinned_ssh_2222_over_wg0_key_not_on_replicated_volume(self):  # TRD s9.5, 07-SEC key table
        self.assertRegex(self.code, r"-p\s*2222|\b2222\b")
        self.assertIn("StrictHostKeyChecking=yes", self.code, "host key pinned")
        self.assertRegex(self.code, r"UserKnownHostsFile=", "pinned known_hosts file")
        self.assertIn("object_replica_ssh_key", self.code, "secret id from the schema")
        self.assertRegex(self.code, r"(?s)object_replica_ssh_key.{0,400}mode:\s*\"?0?600", "private key mode 0600")
        self.assertIn("no_log: true", self.code, "key never logged")
        self.assertNotRegex(self.code, r"/srv/lims/storage/[^\s]*(key|id_)", "key must not live on the replicated volume")
        self.assertRegex(self.code, r"/run/lims/secrets/|/etc/lims/", "key on tmpfs or root-only /etc/lims")

    def test_target_comes_from_inventory_not_hardcoded(self):  # LD-45: lean + full both pass
        self.assertRegex(self.code, r"groups\[\s*['\"]dr['\"]\s*\]", "replica host = first host of group dr")
        self.assertRegex(self.code, r"hostvars\[", "dest address from hostvars (wg_ip)")
        self.assertRegex(self.code, r"groups\[\s*['\"]dr['\"]\s*\][^\n]*(length|\|\s*count|default)",
                         "dev inventory has an EMPTY dr group: role must guard it (no timers/dest, no crash)")
        self.assertNotRegex(self.code, r"\b(dr-1|app-1|data-1|ops-1|prod-1|backup-1)\b", "no host names in role code (LD-45)")
        self.assertNotRegex(self.code, r"\b(?!127\.0\.0\.1\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "no IP literals")

    def test_replica_target_dir_provisioned_on_dr(self):
        self.assertIn("/replica/storage", self.all)
        self.assertRegex(self.code, r"'dr' in group_names|\"dr\" in group_names", "dr-side tasks gated by group")
        if re.search(r"authorized_key", self.code):
            self.assertRegex(self.code, r"restrict", "authorized key for the replica user must carry `restrict`")

    def test_interval_from_inventory_var(self):
        self.assertIn("object_replica_interval_min", self.all)
        for inv in ("dev", "staging", "prod"):
            g = yaml.safe_load(need(INVS / inv / "group_vars" / "all.yml"))
            self.assertEqual(g["object_replica_interval_min"], 15)

    def test_timers_and_units_exist_with_contract_names(self):
        names = [Path(k).name for k in self.files]
        for stem in ("lims-object-replica.timer", "lims-object-replica.service",
                     "lims-object-replica-verify.timer", "lims-object-replica-verify.service"):
            self.assertTrue(any(n == stem or n == stem + ".j2" for n in names), "missing unit %s[.j2]" % stem)

    def test_sync_timer_renders_the_configured_interval(self):  # "15-min rsync"
        t = find_unit(r"^lims-object-replica\.timer")
        for n in (15, 20):
            out = render(t, object_replica_interval_min=n)
            m = re.search(r"OnUnitActiveSec=\s*(\d+)\s*(?:min|m)\b|OnCalendar=\*:0?/(\d+)|OnCalendar=\*:0/(\d+)", out)
            self.assertTrue(m, "no %d-minute schedule in:\n%s" % (n, out))
            self.assertEqual(int(next(g for g in m.groups() if g)), n)
        self.assertRegex(render(t, object_replica_interval_min=15), r"\[Install\][^\[]*WantedBy=timers\.target")

    def test_verify_timer_is_nightly_in_utc(self):  # nightly checksum pass, TRD s9.3 UTC convention
        out = render(find_unit(r"^lims-object-replica-verify\.timer"), object_replica_interval_min=15)
        self.assertRegex(out, r"OnCalendar=[^\n]*\d{2}:\d{2}(:\d{2})?\s+UTC", "daily at HH:MM UTC")
        self.assertNotRegex(out, r"OnCalendar=[^\n]*(hourly|\*:|/\d+:)", "must not run more than daily")
        self.assertRegex(out, r"Persistent=true")

    def test_services_run_the_script_oneshot_with_textfile_dir(self):
        sync = find_unit(r"^lims-object-replica\.service")
        ver = find_unit(r"^lims-object-replica-verify\.service")
        for s in (sync, ver):
            self.assertRegex(s, r"Type=oneshot", "oneshot = a timer can never overlap itself")
            self.assertRegex(s, r"ExecStart=[^\n]*lims-object-replica\.sh")
            self.assertIn("TEXTFILE_DIR=/var/lib/node_exporter/textfile", s)
        self.assertRegex(ver, r"ExecStart=[^\n]*lims-object-replica\.sh[^\n]*\bverify\b")
        self.assertNotRegex(sync, r"ExecStart=[^\n]*\bverify\b")

    def test_applied_in_site_playbook_to_app_and_dr(self):
        plays = yaml.safe_load(need(SITE))
        hosts = []
        for p in plays:
            roles = [r if isinstance(r, str) else r.get("role") for r in p.get("roles", [])]
            if "object_replica" in roles:
                hosts += re.split(r"[:,]", str(p["hosts"]))
        self.assertIn("app", hosts, "object_replica must run on the Storage host (app)")
        self.assertIn("dr", hosts, "and prepare the replica target (dr)")
        self.assertNotIn("all", hosts)
        self.assertNotIn("ops", hosts)

    def test_preconditions_asserted(self):
        self.assertRegex(self.code, r"ansible\.builtin\.assert", "role validates its inputs")
        self.assertRegex(self.code, r"object_replica_interval_min[^\n]*(>|int|length)", "interval validated (positive int)")


# ---------------------------------------------------------------- script behaviour with a fake rsync
FAKE_RSYNC = r"""#!/usr/bin/env bash
# local-copy emulation of the rsync subset the replica uses. Logs one line per call to $FIX/rsync.log.
echo "$*" >> "$FIX/rsync.log"
dry=0; chk=0; ign=0; itemize=0; fmt=""; paths=(); partial=""
while [ $# -gt 0 ]; do
  case "$1" in
    -e) shift;;
    -n|--dry-run) dry=1;;
    --checksum|-c) chk=1;;
    --ignore-existing) ign=1;;
    --itemize-changes) itemize=1;;
    --out-format=*) fmt="${1#--out-format=}";;
    --out-format) shift; fmt="$1";;
    --partial) partial=bare;;
    --partial-dir=*) partial=dir;;
    --delete*|--del|--remove-source-files) echo "FORBIDDEN $1" >> "$FIX/forbidden.log";;
    --*) ;;
    -?*) f="${1#-}"; case "$f" in *n*) dry=1;; esac; case "$f" in *c*) chk=1;; esac; case "$f" in *i*) itemize=1;; esac;;
    *) paths+=("$1");;
  esac
  shift
done
src="${paths[0]%/}"; dst="${paths[1]%/}"
[ -n "$fmt" ] || fmt="%n"
[ "$itemize" = 1 ] && fmt="%i %n"
[ "$dry" = 0 ] && [ -n "$FAKE_RSYNC_FAIL" ] && { echo "rsync: connection unexpectedly closed" >&2; exit 255; }
mkdir -p "$dst"
while IFS= read -r -d '' f; do
  rel="${f#$src/}"; d="$dst/$rel"
  if [ ! -e "$d" ]; then flags='>f+++++++++'
  elif [ "$ign" = 1 ]; then continue
  elif [ "$chk" = 1 ]; then cmp -s "$f" "$d" && continue; flags='>fc.t......'
  else [ "$(stat -c '%s %Y' "$f")" = "$(stat -c '%s %Y' "$d")" ] && continue; flags='>f.st......'; fi
  line="${fmt//%i/$flags}"; line="${line//%n/$rel}"
  if [ "$dry" = 1 ]; then printf '%s\n' "$line"
  elif [ -n "$FAKE_RSYNC_INTERRUPT" ]; then
    # transfer cut mid-file (rsync(1) --partial): bare --partial keeps the half file under its FINAL name,
    # --partial-dir keeps it in a side dir. Either way the run fails with exit 30 (timeout in data send/receive).
    if [ "$partial" = bare ]; then mkdir -p "$(dirname "$d")"; head -c 3 "$f" > "$d"
    elif [ "$partial" = dir ]; then mkdir -p "$dst/.rsync-partial"; head -c 3 "$f" > "$dst/.rsync-partial/$(basename "$d")"; fi
    echo "rsync error: timeout in data send/receive (code 30)" >&2; exit 30
  else mkdir -p "$(dirname "$d")"; cp -p "$f" "$d"; printf '%s\n' "$line"; fi
done < <(find "$src" -type f -print0)
exit 0
"""


def _sha(p):
    import hashlib
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class ReplicaBehaviourTest(unittest.TestCase):
    def setUp(self):
        need(SCRIPT)
        self.tmp = Path(tempfile.mkdtemp(prefix="t11r-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin, self.src, self.dst, self.out = (self.tmp / n for n in ("bin", "src", "dst", "out"))
        for d in (self.bin, self.src, self.dst, self.out):
            d.mkdir()
        (self.bin / "rsync").write_bytes(FAKE_RSYNC.replace("\r\n", "\n").encode())

    def put(self, rel, data, age=0):
        p = self.src / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        if age:
            t = time.time() - age
            os.utime(p, (t, t))
        return p

    def run_script(self, mode=None, fail=False, extra=None):
        env = dict(os.environ, FIX=_p(self.tmp), REPLICA_SRC=_p(self.src) + "/", REPLICA_DEST=_p(self.dst) + "/",
                   TEXTFILE_DIR=_p(self.out), PATH=_p(self.bin) + os.pathsep + os.environ.get("PATH", ""))
        if fail:
            env["FAKE_RSYNC_FAIL"] = "1"
        env.update(extra or {})
        args = [_bash(), _p(SCRIPT)] + ([mode] if mode else [])
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=120)

    def calls(self):
        f = self.tmp / "rsync.log"
        return f.read_text().splitlines() if f.exists() else []

    def prom(self):
        return "".join(p.read_text() for p in sorted(self.out.glob("*.prom")))

    def metric(self, name):
        m = re.search(r"(?m)^lims_ops_%s(?:\{[^}]*\})?\s+([0-9.eE+-]+)\s*$" % name, self.prom())
        return float(m.group(1)) if m else None

    # --- AC-14.2 write-then-check
    def test_write_then_check_object_reaches_replica_identical(self):
        data = os.urandom(4096)
        self.put("reports/2026/11/r-1.pdf", data)
        self.put("trf/t-9.pdf", b"%PDF synthetic")
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((self.dst / "reports/2026/11/r-1.pdf").read_bytes(), data)
        self.assertEqual(_sha(self.src / "trf/t-9.pdf"), _sha(self.dst / "trf/t-9.pdf"))  # AC-14.3: same SHA-256

    def test_success_writes_last_success_and_lag_under_1800(self):  # AC-14.2 lims_ops_object_replica_lag_seconds < 1800
        self.put("a.pdf", b"x", age=600)
        before = time.time()
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        ok = self.metric("object_replica_last_success_timestamp_seconds")
        lag = self.metric("object_replica_lag_seconds")
        self.assertIsNotNone(ok, "last_success metric missing:\n" + self.prom())
        self.assertGreaterEqual(ok, before - 5)
        self.assertLessEqual(ok, time.time() + 5)
        self.assertIsNotNone(lag, "lag metric missing:\n" + self.prom())
        self.assertLess(lag, 1800)

    def test_second_run_is_idempotent_and_keeps_exit_0(self):
        self.put("a.pdf", b"x")
        self.assertEqual(self.run_script().returncode, 0)
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((self.dst / "a.pdf").read_bytes(), b"x")

    # --- AC-14.2 delete-on-primary-not-propagated
    def test_delete_on_primary_is_not_propagated(self):
        keep = os.urandom(512)
        self.put("reports/keep.pdf", keep)
        self.put("reports/gone.pdf", b"will be deleted on app-1")
        self.assertEqual(self.run_script().returncode, 0)
        (self.src / "reports/gone.pdf").unlink()
        shutil.rmtree(self.src / "reports")  # whole tree wiped (ransomware / operator error)
        self.put("new.pdf", b"n")
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue((self.dst / "reports/gone.pdf").exists(), "deletion on primary propagated to the DR copy (AC-14.2)")
        self.assertEqual((self.dst / "reports/keep.pdf").read_bytes(), keep)
        self.assertTrue((self.dst / "new.pdf").exists())
        self.assertFalse((self.tmp / "forbidden.log").exists(), (self.tmp / "forbidden.log").read_text() if (self.tmp / "forbidden.log").exists() else "")

    def test_overwrite_on_primary_does_not_replace_replica_copy(self):  # 07-SEC A3 ransomware overwrite
        p = self.put("reports/r.pdf", b"original-report-bytes")
        self.assertEqual(self.run_script().returncode, 0)
        p.write_bytes(b"ENCRYPTED-BY-RANSOMWARE")
        t = time.time() + 60
        os.utime(p, (t, t))
        self.assertEqual(self.run_script().returncode, 0)
        self.assertEqual((self.dst / "reports/r.pdf").read_bytes(), b"original-report-bytes")

    def test_no_rsync_call_ever_carries_a_delete_flag_and_flags_are_the_contract(self):
        self.put("a.pdf", b"x", age=100)
        self.assertEqual(self.run_script().returncode, 0)
        calls = self.calls()
        self.assertTrue(calls, "rsync was never called")
        for c in calls:
            self.assertNotRegex(c, r"--(delete|del\b|remove-source)", c)
            self.assertIn("--ignore-existing", c, "every call must keep --ignore-existing: " + c)
        real = [c for c in calls if not re.search(r"((?:^|\s)-[a-zA-Z]*n[a-zA-Z]*\b|--dry-run)", c)]
        self.assertEqual(len(real), 1, "exactly one transferring call per run: %r" % calls)
        for f in ("--partial", "--checksum-choice=xxh128"):
            self.assertIn(f, real[0])
        self.assertRegex(real[0], r"((?:^|\s)-[a-zA-Z]*a[a-zA-Z]*\b|--archive)")
        self.assertRegex(real[0], r"/\s+\S+\s*$", "src keeps its trailing slash (contents, not the dir): " + real[0])

    # --- review T-11 items 1/2: an interrupted file must not sit under its final name (--ignore-existing would skip it forever)
    def test_flags_use_partial_dir_not_bare_partial(self):  # 02-TRD s9.5, 03-APP-FLOW partial transfer
        t = uncommented(need(SCRIPT))
        self.assertRegex(t, r"--partial-dir=\S+")
        self.assertNotRegex(t, r"--partial(?![-\w])", "bare --partial + --ignore-existing strands truncated objects on the replica")

    def test_interrupted_transfer_is_completed_by_next_run_or_shown_as_lag(self):
        self.put("reports/big.pdf", os.urandom(2048), age=600)
        r1 = self.run_script(extra={"FAKE_RSYNC_INTERRUPT": "1"})
        self.assertNotEqual(r1.returncode, 0, "interrupted rsync must fail the run")
        self.assertGreater(self.metric("object_replica_lag_seconds") or 0, 0,
                           "truncated copy hides the pending object: lag 0 (AC-14.2 reads green with a broken copy)")
        r2 = self.run_script()
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        self.assertEqual(_sha(self.dst / "reports/big.pdf"), _sha(self.src / "reports/big.pdf"),
                         "second run left a truncated object on the replica (AC-14.3)")

    # --- lag metric when the transfer cannot complete
    def test_failed_transfer_fails_run_keeps_last_success_and_shows_growing_lag(self):  # ObjectReplicaStale inputs
        self.put("old-pending.pdf", b"o", age=7200)
        self.put("newer-pending.pdf", b"n", age=3000)
        (self.out / "lims_object_replica.prom").write_text(
            "lims_ops_object_replica_last_success_timestamp_seconds 1000\nlims_ops_object_replica_lag_seconds 0\n")
        r = self.run_script(fail=True)
        self.assertNotEqual(r.returncode, 0, "rsync failed but the run reported success")
        ok = self.metric("object_replica_last_success_timestamp_seconds")
        self.assertTrue(ok is None or ok < time.time() - 3600, "last_success advanced after a failed run: %r" % ok)
        lag = self.metric("object_replica_lag_seconds")
        self.assertIsNotNone(lag, "lag must still be exported when the transfer fails:\n" + self.prom())
        self.assertGreater(lag, 2900, "lag = now - newest unsent file (3000 s old)")
        self.assertLess(lag, 3400)
        self.assertGreater(lag, 1800, "alert threshold must be reachable")
        self.assertFalse((self.dst / "old-pending.pdf").exists())

    def test_no_pending_files_means_zero_lag(self):
        self.assertEqual(self.run_script().returncode, 0)  # empty tree
        self.assertEqual(self.metric("object_replica_lag_seconds"), 0.0)

    def test_metrics_have_no_phi_labels(self):  # lint rule from T-19: no PHI labels
        self.put("reports/PATIENT-NAME-john-doe.pdf", b"x")
        self.assertEqual(self.run_script().returncode, 0)
        self.assertNotIn("john", self.prom().lower())
        self.assertNotIn("PATIENT", self.prom())

    def test_odd_filenames_do_not_break_the_run(self):  # injection / quoting at the file boundary
        for n in ("sp ace.pdf", "semi;colon.pdf", "dollar$(id).pdf", "quote'd.pdf", "ünï.pdf"):
            self.put("x/" + n, n.encode())
        r = self.run_script()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for n in ("sp ace.pdf", "semi;colon.pdf", "dollar$(id).pdf", "quote'd.pdf", "ünï.pdf"):
            self.assertTrue((self.dst / "x" / n).exists(), n)

    # --- nightly checksum pass (verify)
    def test_verify_clean_replica_exits_0_and_changes_nothing(self):
        self.put("a.pdf", b"aaaa")
        self.assertEqual(self.run_script().returncode, 0)
        r = self.run_script("verify")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        last = self.calls()[-1]
        self.assertIn("--checksum", last)
        self.assertRegex(last, r"((?:^|\s)-[a-zA-Z]*n[a-zA-Z]*\b|--dry-run)", "verify is read-only")
        self.assertNotRegex(last, r"--(delete|del\b|remove-source)")

    def test_verify_detects_silent_corruption_without_repairing_it(self):  # AC-14.3 / TRD "detects silent corruption"
        p = self.put("reports/r.pdf", b"A" * 1000)
        self.assertEqual(self.run_script().returncode, 0)
        d = self.dst / "reports/r.pdf"
        st = d.stat()
        d.write_bytes(b"B" * 1000)  # same size ...
        os.utime(d, (st.st_atime, st.st_mtime))  # ... and same mtime: only --checksum can see it
        r = self.run_script("verify")
        self.assertNotEqual(r.returncode, 0, "bit-rot on the replica not detected:\n" + r.stdout + r.stderr)
        self.assertIn("r.pdf", r.stdout + r.stderr, "report which object differs")
        self.assertEqual(d.read_bytes(), b"B" * 1000, "verify must never overwrite either side")
        self.assertEqual(p.read_bytes(), b"A" * 1000)

    def test_verify_does_not_flag_objects_not_yet_replicated(self):
        self.put("a.pdf", b"a")
        self.assertEqual(self.run_script().returncode, 0)
        self.put("fresh.pdf", b"written since the last sync")
        r = self.run_script("verify")
        self.assertEqual(r.returncode, 0, "a pending object is lag, not corruption:\n" + r.stdout + r.stderr)
        self.assertFalse((self.dst / "fresh.pdf").exists(), "verify must not transfer")

    def test_unknown_mode_is_refused_before_rsync(self):
        self.put("a.pdf", b"a")
        r = self.run_script("--delete")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.calls(), [], "unknown mode must not reach rsync")


if __name__ == "__main__":
    unittest.main()
