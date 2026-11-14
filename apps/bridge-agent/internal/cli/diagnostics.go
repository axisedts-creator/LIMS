package cli

import (
	"archive/zip"
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/svc"
)

// AC-22.2 / 04-UI-UX §2: status + redacted config + the last 7 days of logs. Never queue payloads, secrets, the token or the code.
const (
	logWindow     = 7 * 24 * time.Hour
	maxConfigSize = 1 << 20
	maxLogSize    = 64 << 20
)

var (
	bearerRe   = regexp.MustCompile(`(?i)(bearer)\s+[A-Za-z0-9._~+/=-]{8,}`)
	userinfoRe = regexp.MustCompile(`(://)[^/\s"'@]+@`)
	// config keys whose value is a secret by name (the values themselves are also scrubbed by shape)
	secretKeyRe = regexp.MustCompile(`(?i)token|password|passwd|secret|enrol|credential|authorization|private|api_?key|^code$|^key$|^auth$`)
)

// redactText removes token- and code-shaped strings, bearer credentials and user:password@ in URLs.
func redactText(s string) string {
	s = svc.RedactSecrets(s)
	s = bearerRe.ReplaceAllString(s, "$1 [redacted]")
	return userinfoRe.ReplaceAllString(s, "${1}[redacted]@")
}

func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, x := range t {
			if secretKeyRe.MatchString(k) {
				t[k] = "[redacted]"
			} else {
				t[k] = redactValue(x)
			}
		}
		return t
	case []any:
		for i := range t {
			t[i] = redactValue(t[i])
		}
		return t
	case string:
		return redactText(t)
	}
	return v
}

func redactConfig(raw []byte) []byte {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return []byte(`{"redacted":"this file is not valid JSON; its content was left out"}`)
	}
	out, err := json.MarshalIndent(redactValue(v), "", "  ")
	if err != nil {
		return []byte(`{"redacted":"this file could not be re-encoded; its content was left out"}`)
	}
	return out
}

func safeName(n string) bool {
	return n != "" && n != "." && n != ".." && !strings.ContainsAny(n, `/\:`) && !strings.Contains(n, "..") && clean(n) == n
}

// outsideDataRoot refuses an --out that is, or is inside, the data root (symlinks resolved), so the archive can never overwrite or
// be mistaken for agent data.
func checkOut(out string, root string) (string, error) {
	abs, err := filepath.Abs(out)
	if err != nil {
		return "", err
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(abs))
	if err != nil {
		return "", errors.New("the output folder does not exist")
	}
	target := filepath.Join(dir, filepath.Base(abs))
	r := filepath.Clean(root)
	if rr, err := filepath.EvalSymlinks(r); err == nil {
		r = rr
	}
	if rel, err := filepath.Rel(r, target); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("--out must not be inside the agent data folder")
	}
	return target, nil
}

func cmdDiagnostics(d Deps, args []string) (func() error, error) {
	fs := newFlags("diagnostics")
	var out string
	fs.StringVar(&out, "out", "", "")
	if err := parse(fs, args, 0); err != nil {
		return nil, err
	}
	if out == "" {
		return nil, usageError{"--out <file.zip> is required"}
	}
	return func() error { return writeDiagnostics(d, out) }, nil
}

func writeDiagnostics(d Deps, out string) (err error) {
	l := d.Env.Layout
	target, err := checkOut(out, l.DataRoot)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600) // never overwrite an existing file
	if err != nil {
		return fmt.Errorf("cannot create the output file: %w", err)
	}
	defer func() {
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			_ = os.Remove(target)
		}
	}()
	zw := zip.NewWriter(f)
	now := d.Now()
	n := 0
	add := func(name string) (io.Writer, error) {
		n++
		return zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate, Modified: now})
	}

	// status.json: re-encoded from the typed schema, so nothing outside the schema can travel
	if st, serr := status.Read(l.StatusDir()); serr == nil {
		w, err := add("status.json")
		if err != nil {
			return err
		}
		raw, _ := json.MarshalIndent(st, "", "  ")
		if _, err := w.Write(raw); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(d.Out, "status.json is not available; it is not in the archive.")
	}

	// config\*.json, redacted
	for _, e := range readDir(l.ConfigDir()) {
		if !safeName(e.Name()) || !strings.EqualFold(filepath.Ext(e.Name()), ".json") || !e.Type().IsRegular() {
			continue
		}
		raw, err := readLimited(filepath.Join(l.ConfigDir(), e.Name()), maxConfigSize)
		if err != nil {
			continue // too big or unreadable: left out rather than risk an unredacted copy
		}
		w, err := add("config/" + e.Name())
		if err != nil {
			return err
		}
		if _, err := w.Write(redactConfig(raw)); err != nil {
			return err
		}
	}

	// logs\*, last 7 days relative to Deps.Now, redacted line by line
	for _, e := range readDir(l.LogsDir()) {
		if !safeName(e.Name()) || !e.Type().IsRegular() {
			continue
		}
		info, err := e.Info()
		if err != nil || info.ModTime().Before(now.Add(-logWindow)) {
			continue
		}
		w, err := add("logs/" + e.Name())
		if err != nil {
			return err
		}
		if err := copyRedacted(w, filepath.Join(l.LogsDir(), e.Name())); err != nil {
			return err
		}
	}
	if err := zw.Close(); err != nil {
		return err
	}
	fmt.Fprintf(d.Out, "Diagnostics written (%d files). It holds status, redacted configuration and the last 7 days of logs; no queue data, token or code.\n", n)
	return nil
}

func readDir(p string) []fs.DirEntry {
	ents, _ := os.ReadDir(p) // a missing folder just means nothing to add
	return ents
}

func readLimited(p string, limit int64) ([]byte, error) {
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("too large")
	}
	return b, nil
}

func copyRedacted(w io.Writer, p string) error {
	f, err := os.Open(p)
	if err != nil {
		return nil // a log that rotated away is not an error
	}
	defer f.Close()
	r := bufio.NewReader(io.LimitReader(f, maxLogSize))
	for {
		line, err := r.ReadString('\n')
		if line != "" {
			if _, werr := io.WriteString(w, redactText(line)); werr != nil {
				return werr
			}
		}
		if err != nil {
			return nil
		}
	}
}
