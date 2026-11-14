"""T-11 live test (tester role): real `lvextend -r` on a MOUNTED XFS LV while a writer keeps writing. Linux root only (CI/staging VM).

Runs only with LIMS_T11_LIVE=1 as root on Linux with lvm2, xfsprogs and losetup. Uses two sparse loop files (no real disk touched,
nothing LUKS here: the LUKS layer is T-03). Proves AC-14.1: the LV is XFS, grows online with lims-lv-grow.sh, the mount never goes
away (a background write loop sees no error) and the filesystem is larger afterwards.
"""
import os
import platform
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
GROW = ROOT / "infra" / "ansible" / "roles" / "luks_volumes" / "files" / "lims-lv-grow.sh"
LIVE = os.environ.get("LIMS_T11_LIVE") == "1" and platform.system() == "Linux" and os.geteuid() == 0 and shutil.which("lvcreate")


def sh(cmd):
    return subprocess.run(["bash", "-ec", cmd], capture_output=True, text=True, timeout=300)


@unittest.skipUnless(LIVE, "set LIMS_T11_LIVE=1 as root on a Linux host with lvm2/xfsprogs (CI/staging)")
class LiveGrow(unittest.TestCase):
    def test_lvextend_r_online_on_mounted_xfs(self):
        tmp = tempfile.mkdtemp(prefix="t11live-")
        self.addCleanup(shutil.rmtree, tmp, True)
        vg, lv, mnt = "vg_t11test", "lv_storage", Path(tmp) / "mnt"
        script = f"""
        truncate -s 300M {tmp}/a.img; truncate -s 300M {tmp}/b.img
        A=$(losetup -f --show {tmp}/a.img); B=$(losetup -f --show {tmp}/b.img)
        echo "$A $B" > {tmp}/loops
        pvcreate -q "$A" "$B"; vgcreate -q {vg} "$A"; lvcreate -q -y -L 200M -n {lv} {vg}
        mkfs.xfs -q /dev/{vg}/{lv}; mkdir -p {mnt}; mount /dev/{vg}/{lv} {mnt}
        vgextend -q {vg} "$B"
        """
        self.addCleanup(lambda: sh(f"umount {mnt} 2>/dev/null; vgremove -qf {vg} 2>/dev/null; "
                                   f"for l in $(cat {tmp}/loops 2>/dev/null); do losetup -d $l; done; true"))
        self.assertEqual(sh(script).returncode, 0)
        self.assertEqual(sh(f"findmnt -n -o FSTYPE {mnt}").stdout.strip(), "xfs")
        before = int(sh(f"stat -f -c '%b' {mnt}").stdout)
        w = subprocess.Popen(["bash", "-c", f"for i in $(seq 1 200); do echo $i > {mnt}/f$i || exit 3; sleep 0.02; done"])
        r = subprocess.run(["bash", str(GROW), f"{vg}/{lv}", "+100M"], capture_output=True, text=True, timeout=120)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(w.wait(timeout=60), 0, "writer failed while the LV was growing: not online")
        after = int(sh(f"stat -f -c '%b' {mnt}").stdout)
        self.assertGreater(after, before, "filesystem did not grow")
        self.assertEqual(sh(f"findmnt -n {mnt}").returncode, 0, "mount vanished")


if __name__ == "__main__":
    unittest.main()
