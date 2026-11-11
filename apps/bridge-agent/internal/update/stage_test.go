package update_test

// AC-15.2: size, SHA-256, internal Ed25519 release signature and Authenticode publisher of agent.exe; any failure -> not installed,
// update_state verify_failed. REQ-SEC-119, AB7 (07-SECURITY).
import (
	"path/filepath"
	"testing"

	"lims/apps/bridge-agent/internal/update"
)

func TestStageGoodPackage(t *testing.T) {
	r := newRig(t)
	rel := r.stage("1.1.0")
	if got := r.read(filepath.Join("versions", "1.1.0", "agent.exe")); string(got) != string(agentBytes("1.1.0")) {
		t.Fatalf("agent.exe not unpacked verbatim: %q", got)
	}
	if !r.exists(filepath.Join("versions", "1.1.0", "manifest.json")) || !r.exists(filepath.Join("versions", "1.1.0.zip")) {
		t.Fatal("manifest.json and the kept versions\\1.1.0.zip must exist (the launcher re-verifies the zip)")
	}
	if jsonField(t, r.read("pending.json"), "version") != "1.1.0" {
		t.Fatalf("pending.json must name version 1.1.0: %s", r.read("pending.json"))
	}
	if st, err := update.ReadStatus(r.root); err != nil || st.State != update.StateStaged || st.TargetVersion != rel.Version {
		t.Fatalf("status = %+v, %v; want staged for 1.1.0", st, err)
	}
}

func TestStageRejects(t *testing.T) {
	good := func(r *rig) ([]byte, update.Release) { return r.pkg("1.1.0") }
	cases := []struct {
		name string
		mut  func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode)
	}{
		{"size mismatch", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			rel.PackageSize++
			return z, rel, r.keys, r.auth
		}},
		{"tampered zip (bit flip), release row unchanged", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			c := append([]byte(nil), z...)
			c[len(c)/2] ^= 0x01
			return c, rel, r.keys, r.auth
		}},
		{"tampered zip with a recomputed SHA-256 but the old signature", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			z2 := buildZip(r.t, entry{"agent.exe", []byte("MZ attacker agent")}, entry{"manifest.json", []byte(`{}`)})
			r.auth.trust([]byte("MZ attacker agent"), goodPub)
			forged := signRelease("1.1.0", z2, r.priv, relKeyID, goodPub)
			forged.Signature = rel.Signature // attacker has no release key: reuses the genuine signature
			return z2, forged, r.keys, r.auth
		}},
		{"signed by an untrusted key under a trusted key_id", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			_, other := relPair("attacker-key")
			return z, signRelease("1.1.0", z, other, relKeyID, goodPub), r.keys, r.auth
		}},
		{"unknown key_id", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			rel.KeyID = "rel-unknown"
			return z, rel, r.keys, r.auth
		}},
		{"no trusted keys at all (fail closed, like EmbeddedReleaseKeys)", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			return z, rel, update.ReleaseKeys{}, r.auth
		}},
		{"signature is not base64url", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			rel.Signature = "!!not-base64!!"
			return z, rel, r.keys, r.auth
		}},
		{"wrong publisher (signer is not the expected CN)", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			rel.AuthenticodePublisher = evilPub // release row expects Evil Corp; the exe is signed by goodPub
			return z, signRelease("1.1.0", z, r.priv, relKeyID, evilPub), r.keys, r.auth
		}},
		{"publisher differs only by case/suffix", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			return z, signRelease("1.1.0", z, r.priv, relKeyID, goodPub+" Ltd"), r.keys, r.auth
		}},
		{"agent.exe has no valid Authenticode signature", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			return z, rel, r.keys, &fakeAuth{} // trusts nothing
		}},
		{"nil Authenticode verifier must fail closed, not skip the check", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			return z, rel, r.keys, nil
		}},
		{"zip without agent.exe", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			z2 := buildZip(r.t, entry{"manifest.json", []byte(`{}`)})
			return z2, signRelease("1.1.0", z2, r.priv, relKeyID, goodPub), r.keys, r.auth
		}},
		{"zip-slip entry ../evil.exe (validly signed)", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			z2 := buildZip(r.t, entry{"agent.exe", agentBytes("1.1.0")}, entry{"../evil.exe", []byte("MZ evil")})
			return z2, signRelease("1.1.0", z2, r.priv, relKeyID, goodPub), r.keys, r.auth
		}},
		{"zip-slip entry with backslashes", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			z2 := buildZip(r.t, entry{"agent.exe", agentBytes("1.1.0")}, entry{`..\..\evil.exe`, []byte("MZ evil")})
			return z2, signRelease("1.1.0", z2, r.priv, relKeyID, goodPub), r.keys, r.auth
		}},
		{"zip entry with an absolute path", func(r *rig, z []byte, rel update.Release) ([]byte, update.Release, update.ReleaseKeys, update.Authenticode) {
			z2 := buildZip(r.t, entry{"agent.exe", agentBytes("1.1.0")}, entry{`C:\Windows\evil.exe`, []byte("MZ evil")})
			return z2, signRelease("1.1.0", z2, r.priv, relKeyID, goodPub), r.keys, r.auth
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			r.installed("1.0.0")
			before := r.read("current.json")
			z, rel := good(r)
			z, rel, keys, av := c.mut(r, z, rel)
			err := update.Stage(r.root, r.part("1.1.0", z), rel, keys, av)
			wantVerifyFailed(t, err)
			r.notStaged("1.1.0")
			if string(r.read("current.json")) != string(before) {
				t.Fatal("current.json changed by a failed verification")
			}
			for _, p := range []string{"evil.exe", filepath.Join("versions", "evil.exe"), filepath.Join("..", "evil.exe")} {
				if r.exists(p) {
					t.Fatalf("zip-slip wrote %s", p)
				}
			}
		})
	}
}

// A release row whose version would escape versions\ must never be used to build a path (REQ-SEC-119, path traversal).
func TestStageRejectsHostileVersionString(t *testing.T) {
	for _, v := range []string{"../1.1.0", `..\..\x`, "1.1", "1.1.0-beta", "1.1.0/../../x", "", "a.b.c", "1.1.0\x00"} {
		t.Run(v, func(t *testing.T) {
			r := newRig(t)
			z, rel := r.pkg("1.1.0")
			rel.Version = v
			err := update.Stage(r.root, r.part("1.1.0", z), rel, r.keys, r.auth)
			wantVerifyFailed(t, err)
			if r.exists("pending.json") {
				t.Fatal("pending.json written for a hostile version")
			}
		})
	}
}

// A failed attempt must not destroy an earlier good staged package or the installed version.
func TestStageFailureKeepsInstalledVersion(t *testing.T) {
	r := newRig(t)
	r.installed("1.0.0")
	z, rel := r.pkg("1.1.0")
	rel.PackageSize++
	wantVerifyFailed(t, update.Stage(r.root, r.part("1.1.0", z), rel, r.keys, r.auth))
	if string(r.read(filepath.Join("versions", "1.0.0", "agent.exe"))) != string(agentBytes("1.0.0")) {
		t.Fatal("installed agent.exe touched")
	}
}

func TestEmbeddedReleaseKeysFailClosedAndIsCopy(t *testing.T) {
	k := update.EmbeddedReleaseKeys()
	if len(k) != 0 {
		t.Fatalf("EmbeddedReleaseKeys has %d keys before the release pipeline provisioned any; must be empty (fail closed)", len(k))
	}
	pub, _ := relPair("x")
	k["injected"] = pub
	if len(update.EmbeddedReleaseKeys()) != 0 {
		t.Fatal("mutating the returned map changed the embedded trust list")
	}
}
