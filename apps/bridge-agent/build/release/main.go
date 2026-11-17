// Command release builds the signed bridge-agent release package and the g_agent_releases seed (AG-T18, 02-TRD 5.11, CR-C7-012).
//
//	release --version X.Y.Z --agent-exe <exe> --out <dir> --env staging|production --key-id <id> --release-key-file <PKCS#8 PEM>
//	        --authenticode-publisher <CN> [--authenticode-hook <exe>] [--nonprod] [--channel stable|beta] [--released-at RFC3339]
//	        [--release-id <uuid>] [--notes <text>] [--min-windows-build <int>] [--dry-run]
//	release verify --package <zip> --release <release json> --public-key-file <PKIX PEM>
package main

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	versionRE = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
	uuidRE    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// row is the g_agent_releases row (snake_case; superset of update.Release).
type row struct {
	ID                    string `json:"id"`
	Version               string `json:"version"`
	Channel               string `json:"channel"`
	PackageFileName       string `json:"package_file_name"`
	PackageSHA256         string `json:"package_sha256"`
	PackageSize           int64  `json:"package_size"`
	Signature             string `json:"signature"`
	KeyID                 string `json:"key_id"`
	AuthenticodePublisher string `json:"authenticode_publisher"`
	MinWindowsBuild       *int   `json:"min_windows_build,omitempty"`
	ReleasedAt            string `json:"released_at"`
	Notes                 string `json:"notes,omitempty"`
}

func main() {
	var err error
	if len(os.Args) > 1 && os.Args[1] == "verify" {
		err = verify(os.Args[2:])
	} else {
		err = run(os.Args[1:])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "release:", err)
		os.Exit(1)
	}
}

func textOK(name, v string, min, max int) error {
	if n := utf8.RuneCountInString(v); n < min || n > max || !utf8.ValidString(v) || strings.ContainsRune(v, 0) {
		return fmt.Errorf("%s: want %d..%d valid characters, no NUL", name, min, max)
	}
	return nil
}

func run(args []string) error {
	fs := flag.NewFlagSet("release", flag.ContinueOnError)
	var (
		version   = fs.String("version", "", "X.Y.Z")
		agentExe  = fs.String("agent-exe", "", "built agent.exe")
		out       = fs.String("out", "", "output directory")
		envName   = fs.String("env", "", "staging|production")
		keyID     = fs.String("key-id", "", "release key id")
		keyFile   = fs.String("release-key-file", "", "Ed25519 PKCS#8 PEM private key")
		publisher = fs.String("authenticode-publisher", "", "expected Authenticode signer CN")
		hook      = fs.String("authenticode-hook", "", "signing hook executable")
		nonprod   = fs.Bool("nonprod", false, "skip Authenticode (never with production)")
		channel   = fs.String("channel", "stable", "stable|beta")
		releasedS = fs.String("released-at", "", "RFC3339 (default now)")
		releaseID = fs.String("release-id", "", "uuid (default UUIDv7)")
		notes     = fs.String("notes", "", "release notes")
		minBuild  = fs.Int("min-windows-build", 0, "minimum Windows build")
		dryRun    = fs.Bool("dry-run", false, "staging rehearsal; nothing is published (this tool never uploads)")
	)
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 0 {
		return fmt.Errorf("unexpected arguments %q", fs.Args())
	}

	// --- validation (bounds = 05-SCHEMA g_agent_releases CHECKs); nothing is written before this passes ---
	if !versionRE.MatchString(*version) {
		return errors.New("version: want X.Y.Z")
	}
	if *channel != "stable" && *channel != "beta" {
		return errors.New("channel: want stable|beta")
	}
	if *envName != "staging" && *envName != "production" {
		return errors.New("env: want staging|production")
	}
	if err := textOK("key-id", *keyID, 1, 32); err != nil {
		return err
	}
	if err := textOK("authenticode-publisher", *publisher, 1, 200); err != nil {
		return err
	}
	if err := textOK("notes", *notes, 0, 2000); err != nil {
		return err
	}
	if *minBuild < 0 {
		return errors.New("min-windows-build: want a positive integer")
	}
	if *out == "" || *agentExe == "" || *keyFile == "" {
		return errors.New("--out, --agent-exe and --release-key-file are required")
	}
	zipName := "bridge-agent-" + *version + "-windows-amd64.zip"
	if len(zipName) > 120 {
		return errors.New("version too long (package_file_name <= 120)")
	}
	id := *releaseID
	if id == "" {
		id = uuidV7()
	} else if !uuidRE.MatchString(id) {
		return errors.New("release-id: want a lowercase uuid")
	}
	releasedAt := time.Now().UTC().Truncate(time.Second)
	if *releasedS != "" {
		t, err := time.Parse(time.RFC3339, *releasedS)
		if err != nil {
			return errors.New("released-at: want RFC3339")
		}
		releasedAt = t.UTC()
	}
	if releasedAt.Year() < 1980 || releasedAt.Year() > 2107 {
		return errors.New("released-at: year outside the zip range 1980..2107")
	}
	// Production gate (06 R3): never unsigned. Anywhere else, skipping the hook must be explicit.
	if *envName == "production" && *nonprod {
		return errors.New("--nonprod is refused with --env production")
	}
	if !*nonprod && *hook == "" {
		return errors.New("--authenticode-hook is required (or --nonprod outside production)")
	}

	priv, err := readKey(*keyFile)
	if err != nil {
		return err
	}
	exe, err := os.ReadFile(*agentExe)
	if err != nil {
		return fmt.Errorf("agent-exe: %w", err)
	}
	if len(exe) == 0 {
		return errors.New("agent-exe is empty")
	}

	// --- Authenticode on a private COPY of the exe ---
	tmp, err := os.MkdirTemp("", "release-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	if !*nonprod {
		staged, err := filepath.Abs(filepath.Join(tmp, "agent.exe"))
		if err != nil {
			return err
		}
		if err := os.WriteFile(staged, exe, 0o700); err != nil {
			return err
		}
		cmd := exec.Command(*hook, staged) // no shell
		cmd.Dir = tmp
		if o, err := cmd.CombinedOutput(); err != nil {
			if len(o) > 512 {
				o = o[:512]
			}
			return fmt.Errorf("authenticode hook failed: %v: %s", err, bytes.TrimSpace(o))
		}
		if exe, err = os.ReadFile(staged); err != nil || len(exe) == 0 {
			return errors.New("authenticode hook left no agent.exe")
		}
	}

	// --- package (reproducible: fixed order, mode and timestamps) ---
	manifest, _ := json.Marshal(map[string]string{"version": *version})
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	for _, f := range []struct {
		name string
		data []byte
	}{{"agent.exe", exe}, {"manifest.json", manifest}} {
		h := &zip.FileHeader{Name: f.name, Method: zip.Deflate, Modified: releasedAt}
		h.SetMode(0o644)
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if _, err := w.Write(f.data); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	pkg := zb.Bytes()
	sum := sha256.Sum256(pkg)

	r := row{
		ID: id, Version: *version, Channel: *channel, PackageFileName: zipName,
		PackageSHA256: hex.EncodeToString(sum[:]), PackageSize: int64(len(pkg)),
		Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(priv, sum[:])), // over the RAW hash bytes
		KeyID:     *keyID, AuthenticodePublisher: *publisher,
		ReleasedAt: releasedAt.Format(time.RFC3339), Notes: *notes,
	}
	if *minBuild > 0 {
		r.MinWindowsBuild = minBuild
	}
	var js bytes.Buffer
	enc := json.NewEncoder(&js)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		return err
	}

	// --- write only under --out; remove what was written if any write fails ---
	if err := os.MkdirAll(*out, 0o755); err != nil {
		return err
	}
	files := []struct {
		name string
		data []byte
	}{
		{zipName, pkg},
		{"release-" + *version + ".json", js.Bytes()},
		{"g_agent_releases-" + *version + ".seed.sql", []byte(seedSQL(r))},
	}
	for i, f := range files {
		if err := os.WriteFile(filepath.Join(*out, f.name), f.data, 0o644); err != nil {
			for _, g := range files[:i+1] {
				_ = os.Remove(filepath.Join(*out, g.name))
			}
			return err
		}
	}
	fmt.Printf("release %s (%s, key %s) sha256=%s size=%d\n", *version, *envName, *keyID, r.PackageSHA256, r.PackageSize)
	if *dryRun {
		fmt.Println("dry-run: artefacts written to --out only; nothing published")
	}
	return nil
}

func q(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

// seedSQL is one idempotent INSERT; every text value is a quote-escaped literal (standard_conforming_strings: no backslash escapes).
func seedSQL(r row) string {
	build, notes := "NULL", "NULL"
	if r.MinWindowsBuild != nil {
		build = fmt.Sprint(*r.MinWindowsBuild)
	}
	if r.Notes != "" {
		notes = q(r.Notes)
	}
	return fmt.Sprintf(`INSERT INTO instruments.g_agent_releases
  (id, version, channel, package_file_name, package_sha256, package_size, signature, key_id,
   authenticode_publisher, min_windows_build, released_at, notes)
VALUES (
  %s,
  %s,
  %s,
  %s,
  %s,
  %d,
  %s,
  %s,
  %s,
  %s,
  %s::timestamptz,
  %s
)
ON CONFLICT (version) DO NOTHING;
`, q(r.ID), q(r.Version), q(r.Channel), q(r.PackageFileName), q(r.PackageSHA256), r.PackageSize, q(r.Signature),
		q(r.KeyID), q(r.AuthenticodePublisher), build, q(r.ReleasedAt), notes)
}

func readKey(path string) (ed25519.PrivateKey, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("release-key-file: unreadable")
	}
	blk, _ := pem.Decode(b)
	if blk == nil || blk.Type != "PRIVATE KEY" {
		return nil, errors.New("release-key-file: not a PKCS#8 PEM private key")
	}
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil { // never wrap err: keep key material out of messages
		return nil, errors.New("release-key-file: invalid PKCS#8 key")
	}
	priv, ok := k.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("release-key-file: only Ed25519 keys are accepted")
	}
	return priv, nil
}

func uuidV7() string {
	var u [16]byte
	_, _ = rand.Read(u[:])
	var ms [8]byte
	binary.BigEndian.PutUint64(ms[:], uint64(time.Now().UnixMilli()))
	copy(u[:6], ms[2:])
	u[6] = u[6]&0x0f | 0x70
	u[8] = u[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", u[0:4], u[4:6], u[6:8], u[8:10], u[10:])
}

func verify(args []string) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	pkgPath := fs.String("package", "", "release zip")
	relPath := fs.String("release", "", "release json")
	pubPath := fs.String("public-key-file", "", "PKIX PEM Ed25519 public key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *pkgPath == "" || *relPath == "" || *pubPath == "" || fs.NArg() != 0 {
		return errors.New("verify: --package, --release and --public-key-file are required")
	}
	pkg, err := os.ReadFile(*pkgPath)
	if err != nil {
		return err
	}
	rb, err := os.ReadFile(*relPath)
	if err != nil {
		return err
	}
	var r row
	if err := json.NewDecoder(io.LimitReader(bytes.NewReader(rb), 1<<20)).Decode(&r); err != nil {
		return fmt.Errorf("release json: %w", err)
	}
	pb, err := os.ReadFile(*pubPath)
	if err != nil {
		return err
	}
	blk, _ := pem.Decode(pb)
	if blk == nil || blk.Type != "PUBLIC KEY" {
		return errors.New("public-key-file: not a PKIX PEM public key")
	}
	k, err := x509.ParsePKIXPublicKey(blk.Bytes)
	pub, ok := k.(ed25519.PublicKey)
	if err != nil || !ok {
		return errors.New("public-key-file: not an Ed25519 public key")
	}
	sum := sha256.Sum256(pkg)
	if int64(len(pkg)) != r.PackageSize {
		return errors.New("size mismatch")
	}
	if hex.EncodeToString(sum[:]) != r.PackageSHA256 {
		return errors.New("sha256 mismatch")
	}
	sig, err := base64.RawURLEncoding.DecodeString(r.Signature)
	if err != nil || !ed25519.Verify(pub, sum[:], sig) {
		return errors.New("signature invalid")
	}
	fmt.Println("verify ok:", r.Version)
	return nil
}
