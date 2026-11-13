package main_test

// AG-T18 tests: release pipeline tool (02-TRD 5.11, 05-SCHEMA g_agent_releases, 07-SECURITY REQ-SEC-119/128, 06 R3, CR-C7-012).
// The spec names only: artefact bridge-agent-<version>-windows-amd64.zip = agent.exe + manifest.json; the g_agent_releases row
// (Ed25519 by the release key over the raw SHA-256 of the zip, key_id, authenticode_publisher, channel); keys from a secret-store
// file; Authenticode applied by a pipeline hook; production gate blocks unsigned releases. EVERYTHING BELOW IS THE TESTS' CONTRACT
// for the writer (flag/file names are not in the spec). Package main in this directory (go build .), crypto = Go stdlib only.
//
//	release --version X.Y.Z --agent-exe <built agent.exe> --out <dir> --env staging|production --key-id <id>
//	        --release-key-file <PKCS#8 PEM Ed25519 private key> --authenticode-publisher <CN>
//	        [--authenticode-hook <exe>]  run as `<exe> <absolute path of the staged COPY of agent.exe>`, no shell; it signs the file in place; non-zero = abort
//	        [--nonprod]                  skip the Authenticode step (refused with --env production)
//	        [--channel stable|beta (default stable)] [--released-at RFC3339 (default now)] [--release-id <uuid> (default UUIDv7)]
//	        [--notes <text>] [--min-windows-build <int>] [--dry-run]
//	  writes ONLY into --out (created if missing; nothing is left there when the run fails; the input exe is never modified):
//	    bridge-agent-<version>-windows-amd64.zip       entries exactly `agent.exe` (after the hook) and `manifest.json` ({"version": ...}); reproducible
//	    release-<version>.json                         snake_case g_agent_releases row = update.Release fields (version, package_sha256, package_size,
//	                                                   signature = base64url no padding, key_id, authenticode_publisher) plus channel, package_file_name, id
//	    g_agent_releases-<version>.seed.sql            ONE idempotent INSERT INTO instruments.g_agent_releases (... ON CONFLICT (version) DO NOTHING;)
//	release verify --package <zip> --release <release json> --public-key-file <PKIX PEM Ed25519 public key>   exit 0 only if size, SHA-256 and signature hold
//
// Exit codes: 0 ok, non-zero on any failure (message on stderr, never the private key).

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"

	"lims/apps/bridge-agent/internal/update"
)

const (
	keyID     = "rel-test-1"
	publisher = "LIMS Test Publisher"
	version   = "1.2.3"
	hookMark  = "\nSYNTHETIC-AUTHENTICODE-SIGNATURE"
)

// ---- tool + hook binaries (built once) ----

const hookSrc = `package main

import "os"

var mode = "sign"

func main() {
	if mode == "fail" {
		os.Stderr.WriteString("hook refused\n")
		os.Exit(3)
	}
	p := os.Args[len(os.Args)-1]
	b, err := os.ReadFile(p)
	if err != nil {
		os.Exit(4)
	}
	if err := os.WriteFile(p, append(b, []byte("\nSYNTHETIC-AUTHENTICODE-SIGNATURE")...), 0o600); err != nil {
		os.Exit(5)
	}
}
`

var (
	buildOnce         sync.Once
	toolExe, signHook string
	failHook          string
	buildErr          error
	buildDir          string
)

func TestMain(m *testing.M) {
	code := m.Run()
	if buildDir != "" {
		_ = os.RemoveAll(buildDir)
	}
	os.Exit(code)
}

func build(t *testing.T) {
	t.Helper()
	buildOnce.Do(func() {
		buildDir, buildErr = os.MkdirTemp("", "ag-t18-bin-")
		if buildErr != nil {
			return
		}
		src := filepath.Join(buildDir, "hook", "main.go")
		_ = os.MkdirAll(filepath.Dir(src), 0o700)
		_ = os.WriteFile(src, []byte(hookSrc), 0o600)
		_ = os.WriteFile(filepath.Join(buildDir, "hook", "go.mod"), []byte("module hook\n\ngo 1.21\n"), 0o600)
		toolExe = filepath.Join(buildDir, "release.exe")
		signHook = filepath.Join(buildDir, "hook-sign.exe")
		failHook = filepath.Join(buildDir, "hook-fail.exe")
		type job struct {
			dir, out string
			args     []string
		}
		for _, c := range []job{
			{".", toolExe, nil},
			{filepath.Join(buildDir, "hook"), signHook, nil},
			{filepath.Join(buildDir, "hook"), failHook, []string{"-ldflags=-X main.mode=fail"}},
		} {
			args := append([]string{"build", "-trimpath"}, c.args...)
			args = append(args, "-o", c.out, ".")
			cmd := exec.Command("go", args...)
			cmd.Dir = c.dir
			cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
			if out, err := cmd.CombinedOutput(); err != nil {
				buildErr = fmt.Errorf("go build %s: %v\n%s", c.out, err, out)
				return
			}
		}
	})
	if buildErr != nil {
		t.Fatalf("release tool must build (package main in apps/bridge-agent/build/release): %v", buildErr)
	}
}

// ---- fixtures ----

func pair(label string) (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := sha256.Sum256([]byte(label)) // SYNTHETIC test key, public by construction
	priv := ed25519.NewKeyFromSeed(seed[:])
	return priv.Public().(ed25519.PublicKey), priv
}

func writePEM(t *testing.T, path, typ string, der []byte) {
	t.Helper()
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: typ, Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
}

type env struct {
	t       *testing.T
	dir     string // scratch root
	work    string // cwd of the tool: must stay empty
	out     string
	exe     string // input agent.exe
	exeData []byte
	keyFile string
	pub     ed25519.PublicKey
	priv    ed25519.PrivateKey
}

func newEnv(t *testing.T) *env {
	t.Helper()
	build(t)
	e := &env{t: t, dir: t.TempDir()}
	e.work = filepath.Join(e.dir, "work")
	e.out = filepath.Join(e.dir, "out")
	_ = os.MkdirAll(e.work, 0o700)
	e.exeData = []byte("MZ synthetic agent.exe " + version)
	e.exe = filepath.Join(e.dir, "agent.exe")
	if err := os.WriteFile(e.exe, e.exeData, 0o600); err != nil {
		t.Fatal(err)
	}
	e.pub, e.priv = pair("ag-t18-release")
	der, err := x509.MarshalPKCS8PrivateKey(e.priv)
	if err != nil {
		t.Fatal(err)
	}
	e.keyFile = filepath.Join(e.dir, "release-key.pem")
	writePEM(t, e.keyFile, "PRIVATE KEY", der)
	return e
}

func (e *env) pubFile(pub ed25519.PublicKey) string {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		e.t.Fatal(err)
	}
	p := filepath.Join(e.dir, "pub-"+hex.EncodeToString(pub[:4])+".pem")
	writePEM(e.t, p, "PUBLIC KEY", der)
	return p
}

// base = the staging dry-run with the signing hook.
func (e *env) base(extra ...string) []string {
	a := []string{"--version", version, "--agent-exe", e.exe, "--out", e.out, "--env", "staging", "--key-id", keyID,
		"--release-key-file", e.keyFile, "--authenticode-publisher", publisher, "--authenticode-hook", signHook, "--dry-run"}
	return append(a, extra...)
}

type result struct {
	stdout, stderr string
	code           int
}

func (e *env) run(args ...string) result {
	e.t.Helper()
	cmd := exec.Command(toolExe, args...)
	cmd.Dir = e.work
	var so, se bytes.Buffer
	cmd.Stdout, cmd.Stderr = &so, &se
	err := cmd.Run()
	code := 0
	if err != nil {
		ee, ok := err.(*exec.ExitError)
		if !ok {
			e.t.Fatalf("run %v: %v", args, err)
		}
		code = ee.ExitCode()
	}
	return result{so.String(), se.String(), code}
}

func (e *env) mustRun(args ...string) result {
	e.t.Helper()
	r := e.run(args...)
	if r.code != 0 {
		e.t.Fatalf("expected exit 0, got %d\nstdout: %s\nstderr: %s", r.code, r.stdout, r.stderr)
	}
	return r
}

func (e *env) zipPath(v string) string { return filepath.Join(e.out, "bridge-agent-"+v+"-windows-amd64.zip") }
func (e *env) relPath(v string) string { return filepath.Join(e.out, "release-"+v+".json") }
func (e *env) sqlPath(v string) string { return filepath.Join(e.out, "g_agent_releases-"+v+".seed.sql") }

func (e *env) noArtefacts() {
	e.t.Helper()
	ents, err := os.ReadDir(e.out)
	if err != nil && !os.IsNotExist(err) {
		e.t.Fatal(err)
	}
	if len(ents) != 0 {
		e.t.Fatalf("failed run must leave nothing in --out, found %d entries (first %s)", len(ents), ents[0].Name())
	}
	if w, _ := os.ReadDir(e.work); len(w) != 0 {
		e.t.Fatalf("tool wrote into its working directory: %s", w[0].Name())
	}
}

type relRow struct {
	update.Release
	ID              string `json:"id"`
	Channel         string `json:"channel"`
	PackageFileName string `json:"package_file_name"`
}

func (e *env) readRelease(v string) relRow {
	e.t.Helper()
	b, err := os.ReadFile(e.relPath(v))
	if err != nil {
		e.t.Fatal(err)
	}
	var r relRow
	if err := json.Unmarshal(b, &r); err != nil {
		e.t.Fatalf("release json: %v", err)
	}
	return r
}

func readZip(t *testing.T, path string) map[string][]byte {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("package is not a zip: %v", err)
	}
	defer zr.Close()
	got := map[string][]byte{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(rc)
		rc.Close()
		got[f.Name] = b
	}
	if len(zr.File) != len(got) {
		t.Fatalf("duplicate zip entries")
	}
	return got
}

// fakeAuth stands in for WinVerifyTrustEx: a file counts as signed when the hook's marker is its tail.
type fakeAuth struct{ cn string }

func (f fakeAuth) Publisher(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	if !bytes.HasSuffix(b, []byte(hookMark)) {
		return "", fmt.Errorf("TRUST_E_NOSIGNATURE (fake)")
	}
	return f.cn, nil
}

// stripLiterals blanks every single-quoted SQL literal ('' is an escaped quote); ok=false on an unterminated literal.
func stripLiterals(s string) (string, bool) {
	var b strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case !in && c == '\'':
			in = true
			b.WriteString("''")
		case in && c == '\'':
			if i+1 < len(s) && s[i+1] == '\'' {
				i++
			} else {
				in = false
			}
		case !in:
			b.WriteByte(c)
		}
	}
	return b.String(), !in
}

// ---- done_when: dry-run release in staging -> verifiable package + seed ----

func TestDryRunStagingYieldsVerifiablePackageAndSeed(t *testing.T) {
	e := newEnv(t)
	r := e.mustRun(e.base()...)

	zipBytes, err := os.ReadFile(e.zipPath(version))
	if err != nil {
		t.Fatalf("package missing: %v", err)
	}
	entries := readZip(t, e.zipPath(version))
	if len(entries) != 2 || entries["agent.exe"] == nil || entries["manifest.json"] == nil {
		names := []string{}
		for n := range entries {
			names = append(names, n)
		}
		t.Fatalf("zip must hold exactly agent.exe and manifest.json, got %v", names)
	}
	if want := append(append([]byte{}, e.exeData...), hookMark...); !bytes.Equal(entries["agent.exe"], want) {
		t.Fatalf("agent.exe in the package must be the input exe after the Authenticode hook ran on it")
	}
	if got, _ := os.ReadFile(e.exe); !bytes.Equal(got, e.exeData) {
		t.Fatalf("the input agent.exe must not be modified (hook works on a copy)")
	}
	var man struct{ Version string }
	if err := json.Unmarshal(entries["manifest.json"], &man); err != nil || man.Version != version {
		t.Fatalf("manifest.json must be JSON with version %q: %v %q", version, err, entries["manifest.json"])
	}

	rel := e.readRelease(version)
	sum := sha256.Sum256(zipBytes)
	if rel.Version != version || rel.PackageSHA256 != hex.EncodeToString(sum[:]) || rel.PackageSize != int64(len(zipBytes)) ||
		rel.KeyID != keyID || rel.AuthenticodePublisher != publisher || rel.Channel != "stable" ||
		rel.PackageFileName != filepath.Base(e.zipPath(version)) {
		t.Fatalf("release row does not describe the package: %+v", rel)
	}
	sig, err := base64.RawURLEncoding.DecodeString(rel.Signature)
	if err != nil || !ed25519.Verify(e.pub, sum[:], sig) {
		t.Fatalf("signature must be base64url (no padding) Ed25519 over the RAW SHA-256 bytes of the zip: %v", err)
	}

	// The agent's own verifier (AG-T16) accepts it: size, SHA-256, Ed25519, then Authenticode publisher of the unpacked exe.
	root := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root, "versions"), 0o700)
	part := filepath.Join(root, "versions", version+".zip.part")
	if err := os.WriteFile(part, zipBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := update.Stage(root, part, rel.Release, update.ReleaseKeys{keyID: e.pub}, fakeAuth{publisher}); err != nil {
		t.Fatalf("agent refused the pipeline's package: %v", err)
	}
	if st, _ := update.ReadStatus(root); st.State != update.StateStaged {
		t.Fatalf("status = %+v, want staged", st)
	}

	// ... and rejects it under another release key (the signature binds the key).
	other, _ := pair("ag-t18-other-key")
	root2 := t.TempDir()
	_ = os.MkdirAll(filepath.Join(root2, "versions"), 0o700)
	part2 := filepath.Join(root2, "versions", version+".zip.part")
	_ = os.WriteFile(part2, zipBytes, 0o600)
	if err := update.Stage(root2, part2, rel.Release, update.ReleaseKeys{keyID: other}, fakeAuth{publisher}); err == nil {
		t.Fatalf("package must not verify under a different release key")
	}

	if _, err := os.Stat(e.sqlPath(version)); err != nil {
		t.Fatalf("seed SQL missing: %v", err)
	}
	if strings.Contains(r.stdout+r.stderr, "BEGIN PRIVATE KEY") {
		t.Fatalf("private key leaked to output")
	}
}

// ---- seed SQL ----

func TestSeedSQLIsOneIdempotentInsertWithTheReleaseRow(t *testing.T) {
	e := newEnv(t)
	e.mustRun(e.base("--release-id", "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b", "--released-at", "2026-11-11T09:00:00Z",
		"--channel", "beta", "--min-windows-build", "17763", "--notes", "synthetic dry run")...)
	rel := e.readRelease(version)
	raw, err := os.ReadFile(e.sqlPath(version))
	if err != nil {
		t.Fatal(err)
	}
	sql := string(raw)
	stripped, ok := stripLiterals(sql)
	if !ok {
		t.Fatalf("unterminated string literal in seed SQL")
	}
	if n := strings.Count(strings.ToUpper(stripped), "INSERT INTO INSTRUMENTS.G_AGENT_RELEASES"); n != 1 {
		t.Fatalf("want exactly one INSERT INTO instruments.g_agent_releases, got %d:\n%s", n, sql)
	}
	if strings.Count(stripped, ";") != 1 || !strings.HasSuffix(strings.TrimSpace(stripped), ";") {
		t.Fatalf("seed must be a single statement ending in ';' (outside literals):\n%s", sql)
	}
	up := strings.ToUpper(stripped)
	if !strings.Contains(up, "ON CONFLICT (VERSION) DO NOTHING") {
		t.Fatalf("seed must be idempotent (ON CONFLICT (version) DO NOTHING):\n%s", sql)
	}
	for _, kw := range []string{"DROP ", "DELETE ", "UPDATE ", "TRUNCATE ", "ALTER ", "GRANT "} {
		if strings.Contains(up, kw) {
			t.Fatalf("seed contains %q outside a literal", kw)
		}
	}
	for _, col := range []string{"id", "version", "channel", "package_file_name", "package_sha256", "package_size", "signature", "key_id",
		"authenticode_publisher", "min_windows_build", "released_at", "notes"} {
		if !regexp.MustCompile(`\b` + col + `\b`).MatchString(stripped) {
			t.Fatalf("column %s missing from the INSERT", col)
		}
	}
	for _, lit := range []string{"'0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'", "'" + version + "'", "'beta'", "'" + rel.PackageFileName + "'",
		"'" + rel.PackageSHA256 + "'", "'" + rel.Signature + "'", "'" + keyID + "'", "'" + publisher + "'", "'synthetic dry run'"} {
		if !strings.Contains(sql, lit) {
			t.Fatalf("seed lacks value %s:\n%s", lit, sql)
		}
	}
	if !regexp.MustCompile(`[,(\s]` + fmt.Sprint(rel.PackageSize) + `[,)\s]`).MatchString(stripped) || !strings.Contains(stripped, "17763") {
		t.Fatalf("package_size %d / min_windows_build 17763 must appear as bare integers:\n%s", rel.PackageSize, stripped)
	}
	if !strings.Contains(sql, "2026-11-11") {
		t.Fatalf("released_at from --released-at missing")
	}
	if rel.ID != "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b" || rel.Channel != "beta" {
		t.Fatalf("release json id/channel: %+v", rel)
	}
}

func TestSeedSQLEscapesHostileText(t *testing.T) {
	e := newEnv(t)
	evilNotes := "x'); DROP TABLE instruments.g_agent_releases; --"
	evilCN := "O'Brien Labs, Inc."
	args := e.base("--notes", evilNotes)
	for i, a := range args {
		if a == "--authenticode-publisher" {
			args[i+1] = evilCN
		}
	}
	e.mustRun(args...)
	raw, _ := os.ReadFile(e.sqlPath(version))
	sql := string(raw)
	for _, want := range []string{"'O''Brien Labs, Inc.'", "'x''); DROP TABLE instruments.g_agent_releases; --'"} {
		if !strings.Contains(sql, want) {
			t.Fatalf("hostile text must be quote-escaped, want %s in:\n%s", want, sql)
		}
	}
	stripped, ok := stripLiterals(sql)
	if !ok || strings.Contains(strings.ToUpper(stripped), "DROP") || strings.Count(stripped, ";") != 1 {
		t.Fatalf("injection escaped the literal:\n%s", sql)
	}
	if rel := e.readRelease(version); rel.AuthenticodePublisher != evilCN {
		t.Fatalf("release json publisher = %q", rel.AuthenticodePublisher)
	}
}

// ---- determinism, defaults, dry-run containment ----

func TestRebuildIsReproducible(t *testing.T) {
	a, b := newEnv(t), newEnv(t)
	fix := []string{"--release-id", "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b", "--released-at", "2026-11-11T09:00:00Z"}
	a.mustRun(a.base(fix...)...)
	b.mustRun(b.base(fix...)...)
	for _, n := range []string{filepath.Base(a.zipPath(version)), filepath.Base(a.relPath(version)), filepath.Base(a.sqlPath(version))} {
		x, _ := os.ReadFile(filepath.Join(a.out, n))
		y, _ := os.ReadFile(filepath.Join(b.out, n))
		if len(x) == 0 || !bytes.Equal(x, y) {
			t.Fatalf("%s differs between two identical runs (zip times must come from --released-at; Ed25519 is deterministic)", n)
		}
	}
}

func TestDefaultReleaseIDIsUUIDv7AndChannelStable(t *testing.T) {
	e := newEnv(t)
	e.mustRun(e.base()...)
	rel := e.readRelease(version)
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(rel.ID) {
		t.Fatalf("default id must be a UUIDv7 (TRD 5.10 release_id), got %q", rel.ID)
	}
	raw, _ := os.ReadFile(e.sqlPath(version))
	if !strings.Contains(string(raw), "'stable'") || !strings.Contains(string(raw), "'"+rel.ID+"'") {
		t.Fatalf("seed must carry default channel 'stable' and the generated id")
	}
}

func TestRunWritesOnlyUnderOut(t *testing.T) {
	e := newEnv(t)
	e.mustRun(e.base()...)
	if w, _ := os.ReadDir(e.work); len(w) != 0 {
		t.Fatalf("dry-run littered the working directory: %s", w[0].Name())
	}
	ents, _ := os.ReadDir(e.out)
	if len(ents) != 3 {
		t.Fatalf("--out must hold exactly the zip, release json and seed sql (no temp leftovers), got %d entries", len(ents))
	}
}

// ---- validation: hostile or out-of-range input is refused and leaves nothing ----

func TestRejectsInvalidInputsAndLeavesNothing(t *testing.T) {
	long := func(n int) string { return strings.Repeat("a", n) }
	cases := []struct {
		name  string
		flag  string
		value string
	}{
		{"two-part version", "--version", "1.2"},
		{"prerelease version", "--version", "1.2.3-beta"},
		{"traversal version", "--version", "../1.2.3"},
		{"newline version", "--version", "1.2.3\n"},
		{"shell version", "--version", "1.2.3; calc"},
		{"unknown channel", "--channel", "nightly"},
		{"key id 33 chars", "--key-id", long(33)},
		{"empty key id", "--key-id", ""},
		{"publisher 201 chars", "--authenticode-publisher", long(201)},
		{"empty publisher", "--authenticode-publisher", ""},
		{"notes 2001 chars", "--notes", long(2001)},
		{"bad uuid", "--release-id", "not-a-uuid"},
		{"bad timestamp", "--released-at", "yesterday"},
		{"unknown env", "--env", "dev"},
		{"missing agent exe", "--agent-exe", filepath.Join(os.TempDir(), "ag-t18-no-such-agent.exe")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			args := e.base()
			set := false
			for i, a := range args {
				if a == c.flag {
					args[i+1], set = c.value, true
				}
			}
			if !set {
				args = append(args, c.flag, c.value)
			}
			if r := e.run(args...); r.code == 0 {
				t.Fatalf("must refuse %s=%q", c.flag, c.value)
			}
			e.noArtefacts()
		})
	}
	t.Run("empty agent exe", func(t *testing.T) {
		e := newEnv(t)
		_ = os.WriteFile(e.exe, nil, 0o600)
		if r := e.run(e.base()...); r.code == 0 {
			t.Fatalf("must refuse an empty agent.exe")
		}
		e.noArtefacts()
	})
	t.Run("missing required flag", func(t *testing.T) {
		e := newEnv(t)
		if r := e.run(); r.code == 0 {
			t.Fatalf("no arguments must fail")
		}
		e.noArtefacts()
	})
}

// ---- Authenticode hook + production gate (06 R3, TRD 5.11) ----

func TestAuthenticodeHookFailureAbortsWithNoArtefacts(t *testing.T) {
	e := newEnv(t)
	args := e.base()
	for i, a := range args {
		if a == "--authenticode-hook" {
			args[i+1] = failHook
		}
	}
	r := e.run(args...)
	if r.code == 0 {
		t.Fatalf("a failing signing hook must fail the release")
	}
	e.noArtefacts()
	if got, _ := os.ReadFile(e.exe); !bytes.Equal(got, e.exeData) {
		t.Fatalf("input exe modified")
	}
}

func TestProductionGateBlocksUnsignedReleases(t *testing.T) {
	strip := func(args []string, drop ...string) []string {
		var out []string
		for i := 0; i < len(args); i++ {
			skip := false
			for _, d := range drop {
				if args[i] == d {
					skip = true
					if d == "--authenticode-hook" || d == "--env" || d == "--authenticode-publisher" {
						i++
					}
				}
			}
			if !skip {
				out = append(out, args[i])
			}
		}
		return out
	}
	t.Run("production without hook", func(t *testing.T) {
		e := newEnv(t)
		args := append(strip(e.base(), "--authenticode-hook", "--env"), "--env", "production")
		if r := e.run(args...); r.code == 0 {
			t.Fatalf("production release without an Authenticode hook must be refused")
		}
		e.noArtefacts()
	})
	t.Run("production with nonprod", func(t *testing.T) {
		e := newEnv(t)
		args := append(strip(e.base(), "--authenticode-hook", "--env"), "--env", "production", "--nonprod")
		if r := e.run(args...); r.code == 0 {
			t.Fatalf("--nonprod must never be accepted with --env production")
		}
		e.noArtefacts()
	})
	t.Run("production with hook succeeds", func(t *testing.T) {
		e := newEnv(t)
		args := append(strip(e.base(), "--env"), "--env", "production")
		e.mustRun(args...)
		if _, err := os.Stat(e.zipPath(version)); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("hook without publisher", func(t *testing.T) {
		e := newEnv(t)
		args := strip(e.base(), "--authenticode-publisher")
		if r := e.run(args...); r.code == 0 {
			t.Fatalf("authenticode_publisher is what the agent compares the signer with; it is required")
		}
		e.noArtefacts()
	})
}

// ---- release key handling (REQ-SEC-128) ----

func TestReleaseKeyMustBeAnEd25519PKCS8FileAndNeverLeaks(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		e := newEnv(t)
		_ = os.Remove(e.keyFile)
		if r := e.run(e.base()...); r.code == 0 {
			t.Fatalf("missing key file must fail")
		}
		e.noArtefacts()
	})
	t.Run("garbage", func(t *testing.T) {
		e := newEnv(t)
		_ = os.WriteFile(e.keyFile, []byte("not a key"), 0o600)
		if r := e.run(e.base()...); r.code == 0 {
			t.Fatalf("garbage key must fail")
		}
		e.noArtefacts()
	})
	t.Run("rsa key refused", func(t *testing.T) {
		e := newEnv(t)
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		der, _ := x509.MarshalPKCS8PrivateKey(k)
		writePEM(t, e.keyFile, "PRIVATE KEY", der)
		if r := e.run(e.base()...); r.code == 0 {
			t.Fatalf("only Ed25519 release keys are accepted (alg fixed by TRD D-06)")
		}
		e.noArtefacts()
	})
	t.Run("private key never printed or written", func(t *testing.T) {
		e := newEnv(t)
		r := e.mustRun(e.base()...)
		seed := e.priv.Seed()
		der, _ := x509.MarshalPKCS8PrivateKey(e.priv)
		needles := [][]byte{seed, []byte(hex.EncodeToString(seed)), []byte(base64.StdEncoding.EncodeToString(seed)),
			[]byte(base64.RawURLEncoding.EncodeToString(seed)), []byte(base64.StdEncoding.EncodeToString(der)), []byte("PRIVATE KEY")}
		hay := [][]byte{[]byte(r.stdout), []byte(r.stderr)}
		ents, _ := os.ReadDir(e.out)
		for _, f := range ents {
			b, _ := os.ReadFile(filepath.Join(e.out, f.Name()))
			if strings.HasSuffix(f.Name(), ".zip") {
				for n, d := range readZip(t, filepath.Join(e.out, f.Name())) {
					hay = append(hay, append([]byte(n+"\x00"), d...))
				}
				continue
			}
			hay = append(hay, b)
		}
		for _, h := range hay {
			for _, n := range needles {
				if bytes.Contains(h, n) {
					t.Fatalf("private key material appears in tool output or artefacts")
				}
			}
		}
	})
	t.Run("bad key leaves no secret in stderr", func(t *testing.T) {
		e := newEnv(t)
		_ = os.WriteFile(e.keyFile, []byte("-----BEGIN PRIVATE KEY-----\nSECRETBODY123\n-----END PRIVATE KEY-----\n"), 0o600)
		r := e.run(e.base()...)
		if r.code == 0 || strings.Contains(r.stdout+r.stderr, "SECRETBODY123") {
			t.Fatalf("malformed key must fail without echoing its contents (exit %d)", r.code)
		}
	})
}

// ---- `release verify` (CI check of a produced package) ----

func TestVerifySubcommand(t *testing.T) {
	e := newEnv(t)
	e.mustRun(e.base()...)
	good := []string{"verify", "--package", e.zipPath(version), "--release", e.relPath(version), "--public-key-file", e.pubFile(e.pub)}
	if r := e.run(good...); r.code != 0 {
		t.Fatalf("verify of an untouched package must pass: %s", r.stderr)
	}

	zipBytes, _ := os.ReadFile(e.zipPath(version))
	tampered := append([]byte{}, zipBytes...)
	tampered[len(tampered)/2] ^= 0x01
	bad := filepath.Join(e.dir, "tampered.zip")
	_ = os.WriteFile(bad, tampered, 0o600)
	if r := e.run("verify", "--package", bad, "--release", e.relPath(version), "--public-key-file", e.pubFile(e.pub)); r.code == 0 {
		t.Fatalf("a flipped bit must fail verify")
	}

	short := filepath.Join(e.dir, "short.zip")
	_ = os.WriteFile(short, zipBytes[:len(zipBytes)-1], 0o600)
	if r := e.run("verify", "--package", short, "--release", e.relPath(version), "--public-key-file", e.pubFile(e.pub)); r.code == 0 {
		t.Fatalf("a truncated package must fail verify")
	}

	other, _ := pair("ag-t18-other-key")
	if r := e.run("verify", "--package", e.zipPath(version), "--release", e.relPath(version), "--public-key-file", e.pubFile(other)); r.code == 0 {
		t.Fatalf("verify under a different public key must fail")
	}

	var m map[string]any
	b, _ := os.ReadFile(e.relPath(version))
	_ = json.Unmarshal(b, &m)
	m["signature"] = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.SignatureSize))
	forged, _ := json.Marshal(m)
	fp := filepath.Join(e.dir, "forged.json")
	_ = os.WriteFile(fp, forged, 0o600)
	if r := e.run("verify", "--package", e.zipPath(version), "--release", fp, "--public-key-file", e.pubFile(e.pub)); r.code == 0 {
		t.Fatalf("a forged signature must fail verify")
	}
}
