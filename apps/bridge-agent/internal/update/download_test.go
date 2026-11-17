package update_test

// 02-TRD 5.11: download via downloadAgentRelease (E08) to versions\<version>.zip.part. Transport is TLS-only; the bytes are untrusted
// until Stage verifies them, so Download only has to bound the size and never leak the device token.
import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"lims/apps/bridge-agent/internal/update"
)

const testToken = "dev-token-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestDownloadWritesPartFileWithBearerToken(t *testing.T) {
	r := newRig(t)
	z, rel := r.pkg("1.1.0")
	var mu sync.Mutex
	var auth string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		mu.Lock()
		auth = q.Header.Get("Authorization")
		mu.Unlock()
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(z)
	}))
	defer srv.Close()
	part, err := update.Download(context.Background(), srv.Client(), srv.URL+"/v1/instruments/agent/releases/r1/package", testToken, r.root, rel)
	if err != nil {
		t.Fatalf("Download: %v", err)
	}
	if want := r.path("versions", "1.1.0.zip.part"); part != want {
		t.Fatalf("part path = %q, want %q", part, want)
	}
	if b, _ := os.ReadFile(part); string(b) != string(z) {
		t.Fatal("part file differs from the served bytes")
	}
	mu.Lock()
	defer mu.Unlock()
	if auth != "Bearer "+testToken {
		t.Fatalf("Authorization = %q, want Bearer token", auth)
	}
}

func TestDownloadRefusesPlainHTTP(t *testing.T) {
	r := newRig(t)
	_, rel := r.pkg("1.1.0")
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) { hit = true }))
	defer srv.Close()
	_, err := update.Download(context.Background(), srv.Client(), srv.URL+"/p", testToken, r.root, rel)
	if err == nil || hit {
		t.Fatalf("plain http download must be refused before any request (err=%v, requested=%v)", err, hit)
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatal("error leaks the device token")
	}
}

func TestDownloadFailures(t *testing.T) {
	r0 := newRig(t)
	z, rel := r0.pkg("1.1.0")
	cases := []struct {
		name    string
		handler http.HandlerFunc
	}{
		{"404", func(w http.ResponseWriter, q *http.Request) { http.Error(w, "common.not_found", http.StatusNotFound) }},
		{"401", func(w http.ResponseWriter, q *http.Request) {
			http.Error(w, "auth.device_token_invalid", http.StatusUnauthorized)
		}},
		{"body larger than the release row's package_size", func(w http.ResponseWriter, q *http.Request) {
			_, _ = w.Write(append(append([]byte(nil), z...), make([]byte, 4096)...))
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t)
			srv := httptest.NewTLSServer(c.handler)
			defer srv.Close()
			_, err := update.Download(context.Background(), srv.Client(), srv.URL+"/p", testToken, r.root, rel)
			var ue *update.Error
			if !errors.As(err, &ue) || ue.State != update.StateFailed {
				t.Fatalf("want *update.Error State %q, got %T: %v", update.StateFailed, err, err)
			}
			if strings.Contains(err.Error(), testToken) {
				t.Fatal("error leaks the device token")
			}
			if m, _ := filepath.Glob(r.path("versions", "*.part")); len(m) != 0 {
				t.Fatalf("partial file left behind after a failed download: %v", m)
			}
		})
	}
}

func TestDownloadRefusesHostileVersion(t *testing.T) {
	r := newRig(t)
	z, rel := r.pkg("1.1.0")
	rel.Version = `..\..\evil`
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) { _, _ = w.Write(z) }))
	defer srv.Close()
	if _, err := update.Download(context.Background(), srv.Client(), srv.URL+"/p", testToken, r.root, rel); err == nil {
		t.Fatal("Download accepted a version that escapes versions\\")
	}
	if r.exists("evil.zip.part") || r.exists(filepath.Join("..", "evil.zip.part")) {
		t.Fatal("wrote outside versions\\")
	}
}
