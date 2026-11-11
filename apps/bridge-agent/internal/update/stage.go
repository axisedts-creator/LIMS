package update

import (
	"archive/zip"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

const (
	maxPackage  = 256 << 20 // zip size cap
	maxUnpacked = 512 << 20 // total uncompressed cap (zip bomb)
	agentExe    = "agent.exe"
)

func verr(format string, a ...any) *Error {
	return &Error{State: StateVerifyFailed, Reason: fmt.Sprintf(format, a...)}
}

// Download fetches the package to root\versions\<version>.zip.part. TLS only; the bytes stay untrusted until Stage verifies them.
func Download(ctx context.Context, c *http.Client, rawURL, token, root string, rel Release) (string, error) {
	fail := func(format string, a ...any) (string, error) {
		writeStatus(root, StateFailed, rel.Version)
		return "", &Error{State: StateFailed, Reason: strings.ReplaceAll(fmt.Sprintf(format, a...), token, "***")}
	}
	if !validVersion(rel.Version) {
		return fail("invalid version")
	}
	if isRolledBack(root, rel.Version) { // status stays rolled_back (AC-15.3)
		return "", &Error{State: StateRolledBack, Reason: "version was rolled back"}
	}
	if rel.PackageSize <= 0 || rel.PackageSize > maxPackage {
		return fail("invalid package_size")
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return fail("package URL must be https")
	}
	if !recordAttempt(root, rel.Version) {
		return fail("retry cap: %d downloads of %s in 24 h", maxAttempts, rel.Version)
	}
	if c == nil {
		c = http.DefaultClient
	}
	dir := filepath.Join(root, "versions")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail("%v", err)
	}
	writeStatus(root, StateDownloading, rel.Version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return fail("%v", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		return fail("request failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fail("HTTP %d", resp.StatusCode)
	}
	part := filepath.Join(dir, rel.Version+".zip.part")
	f, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fail("%v", err)
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, rel.PackageSize+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil || n != rel.PackageSize {
		_ = os.Remove(part)
		if err != nil {
			return fail("read failed: %v", err)
		}
		return fail("package is %d bytes, release says %d", n, rel.PackageSize)
	}
	return part, nil
}

const maxAttempts = 3 // 03-APP-FLOW 3.6: max 3/day [CONV]

// recordAttempt drops attempts older than 24 h and records one for version unless it already has maxAttempts in the last 24 h.
func recordAttempt(root, version string) bool {
	now := Now()
	all := map[string][]time.Time{}
	_ = readJSON(filepath.Join(root, attemptsFile), &all)
	for v, ts := range all {
		ts = slices.DeleteFunc(ts, func(t time.Time) bool { return now.Sub(t) >= 24*time.Hour })
		if len(ts) == 0 {
			delete(all, v)
		} else {
			all[v] = ts
		}
	}
	if len(all[version]) >= maxAttempts {
		return false
	}
	all[version] = append(all[version], now)
	_ = writeJSON(filepath.Join(root, attemptsFile), all) // ponytail: unwritable root disables the cap; the download fails there anyway
	return true
}

// verifyZip checks size, SHA-256 and the Ed25519 release signature of a package file against keys.
func verifyZip(zipPath string, rel Release, keys ReleaseKeys) error {
	if rel.PackageSize <= 0 || rel.PackageSize > maxPackage {
		return verr("invalid package_size")
	}
	pub, ok := keys[rel.KeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return verr("unknown release key_id")
	}
	sig, err := base64.RawURLEncoding.DecodeString(rel.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return verr("malformed signature")
	}
	want, err := hex.DecodeString(rel.PackageSHA256)
	if err != nil || len(want) != sha256.Size {
		return verr("malformed package_sha256")
	}
	f, err := os.Open(zipPath)
	if err != nil {
		return verr("package unreadable: %v", err)
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, io.LimitReader(f, rel.PackageSize+1))
	if err != nil {
		return verr("package unreadable: %v", err)
	}
	if n != rel.PackageSize {
		return verr("package size mismatch")
	}
	sum := h.Sum(nil)
	if subtle.ConstantTimeCompare(sum, want) != 1 {
		return verr("package SHA-256 mismatch")
	}
	if !ed25519.Verify(pub, sum, sig) {
		return verr("release signature invalid")
	}
	return nil
}

// checkPublisher runs Authenticode on exe; a nil verifier fails closed.
func checkPublisher(av Authenticode, exe, expected string) error {
	if av == nil {
		return verr("no Authenticode verifier")
	}
	got, err := av.Publisher(exe)
	if err != nil {
		return verr("Authenticode: %v", err)
	}
	if expected == "" || got != expected {
		return verr("Authenticode publisher %q is not the expected publisher", got)
	}
	return nil
}

// Stage verifies partPath (size, SHA-256, Ed25519, then Authenticode publisher of the unpacked agent.exe) and, only if all hold, leaves
// versions\<version>.zip, versions\<version>\ and pending.json. Any failure -> *Error verify_failed and nothing staged (AC-15.2).
func Stage(root, partPath string, rel Release, keys ReleaseKeys, av Authenticode) (err error) {
	if validVersion(rel.Version) && isRolledBack(root, rel.Version) { // status stays rolled_back (AC-15.3)
		_ = os.Remove(partPath)
		return &Error{State: StateRolledBack, Reason: "version was rolled back"}
	}
	vdir := ""
	defer func() {
		if err == nil {
			return
		}
		if vdir != "" {
			_ = os.RemoveAll(vdir)
		}
		_ = os.Remove(partPath)
		_ = os.Remove(filepath.Join(root, pendingFile))
		if !validVersion(rel.Version) {
			rel.Version = ""
		}
		writeStatus(root, StateVerifyFailed, rel.Version)
	}()
	if !validVersion(rel.Version) {
		return verr("invalid version")
	}
	if cur, cerr := readCurrent(root); cerr == nil && cur.Version == rel.Version {
		return verr("version is the running version")
	}
	writeStatus(root, StateVerifying, rel.Version)
	if err := verifyZip(partPath, rel, keys); err != nil {
		return err
	}
	zipPath := filepath.Join(root, "versions", rel.Version+".zip")
	if err := os.Rename(partPath, zipPath); err != nil {
		return verr("keep package: %v", err)
	}
	vdir = filepath.Join(root, "versions", rel.Version)
	if err := os.RemoveAll(vdir); err != nil {
		return verr("clear %s: %v", vdir, err)
	}
	if err := unzip(zipPath, vdir); err != nil {
		return err
	}
	if err := checkPublisher(av, filepath.Join(vdir, agentExe), rel.AuthenticodePublisher); err != nil {
		return err
	}
	if err := writeJSON(filepath.Join(root, pendingFile), rel); err != nil {
		return verr("write pending.json: %v", err)
	}
	vdir = ""
	writeStatus(root, StateStaged, rel.Version)
	return nil
}

// safeName accepts only plain relative slash-separated names: no backslash, drive, absolute path, "." or ".." segment.
func safeName(name string) bool {
	n := strings.TrimSuffix(name, "/")
	return n != "" && !strings.ContainsAny(n, "\\:\x00") && path.Clean(n) == n && filepath.IsLocal(filepath.FromSlash(n))
}

func unzip(zipPath, dst string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return verr("not a zip: %v", err)
	}
	defer zr.Close()
	if err := os.MkdirAll(dst, 0o700); err != nil {
		return verr("%v", err)
	}
	var total uint64
	for _, e := range zr.File {
		if !safeName(e.Name) {
			return verr("unsafe zip entry %q", e.Name)
		}
		out := filepath.Join(dst, filepath.FromSlash(strings.TrimSuffix(e.Name, "/")))
		if e.FileInfo().IsDir() {
			if err := os.MkdirAll(out, 0o700); err != nil {
				return verr("%v", err)
			}
			continue
		}
		if !e.Mode().IsRegular() {
			return verr("zip entry %q is not a regular file", e.Name)
		}
		if total += e.UncompressedSize64; total > maxUnpacked {
			return verr("package unpacks too large")
		}
		if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
			return verr("%v", err)
		}
		if err := extract(e, out); err != nil {
			return err
		}
	}
	if _, err := os.Stat(filepath.Join(dst, agentExe)); err != nil {
		return verr("package has no %s", agentExe)
	}
	return nil
}

func extract(e *zip.File, out string) error {
	rc, err := e.Open()
	if err != nil {
		return verr("%v", err)
	}
	defer rc.Close()
	f, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700) // O_EXCL: duplicate entries are an error
	if err != nil {
		return verr("%v", err)
	}
	n, err := io.Copy(f, io.LimitReader(rc, int64(e.UncompressedSize64)+1))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil || uint64(n) != e.UncompressedSize64 {
		return verr("zip entry %q is corrupt", e.Name)
	}
	return nil
}

// verifyStaged is what the launcher runs on pending.json before switching: the zip against ITS keys, the unpacked agent.exe must be
// byte-identical to the zip's, and its Authenticode publisher must match. Nothing in pending.json or versions\ is trusted on its own.
func verifyStaged(root string, rel Release, keys ReleaseKeys, av Authenticode) error {
	if !validVersion(rel.Version) {
		return verr("invalid version")
	}
	if err := verifyZip(filepath.Join(root, "versions", rel.Version+".zip"), rel, keys); err != nil {
		return err
	}
	exe := filepath.Join(root, "versions", rel.Version, agentExe)
	zsum, err := zipEntrySHA256(filepath.Join(root, "versions", rel.Version+".zip"), agentExe)
	if err != nil {
		return err
	}
	fsum, err := fileSHA256(exe)
	if err != nil {
		return verr("agent.exe unreadable: %v", err)
	}
	if subtle.ConstantTimeCompare(zsum, fsum) != 1 {
		return verr("agent.exe differs from the verified package")
	}
	return checkPublisher(av, exe, rel.AuthenticodePublisher)
}

func fileSHA256(p string) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

func zipEntrySHA256(zipPath, name string) ([]byte, error) {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, verr("not a zip: %v", err)
	}
	defer zr.Close()
	for _, e := range zr.File {
		if e.Name != name {
			continue
		}
		rc, err := e.Open()
		if err != nil {
			return nil, verr("%v", err)
		}
		defer rc.Close()
		h := sha256.New()
		if _, err := io.Copy(h, io.LimitReader(rc, maxUnpacked)); err != nil {
			return nil, verr("%v", err)
		}
		return h.Sum(nil), nil
	}
	return nil, verr("package has no %s", name)
}
