package queue

import (
	"bytes"
	"testing"

	"lims/apps/bridge-agent/internal/secrets"
)

// Integration with the real DPAPI wrap (LD-93/LD-94: Windows 10/11; user scope is the primary path per spike S1,
// machine scope only as the fallback). secrets.DPAPI must satisfy queue.KeyProtector.
func TestQueueWithRealDPAPIUserScope(t *testing.T) {
	path := dbPath(t)
	p := secrets.NewDPAPI(secrets.ScopeUser, []byte("agent-id-synthetic"))
	d := openT(t, path, p, Options{})
	if err := d.InsertItem(in("it-1", "data", []byte("raw synthetic"))); err != nil {
		t.Fatal(err)
	}
	_ = d.Close()
	d2 := openT(t, path, secrets.NewDPAPI(secrets.ScopeUser, []byte("agent-id-synthetic")), Options{})
	got, err := d2.GetItem("it-1")
	if err != nil || !bytes.Equal(got.Raw, []byte("raw synthetic")) {
		t.Fatalf("round trip with DPAPI-wrapped key: %v %q", err, got.Raw)
	}
	_ = d2.Close()
	if bad, err := Open(path, secrets.NewDPAPI(secrets.ScopeUser, []byte("other-entropy")), Options{}); err == nil {
		_ = bad.Close()
		t.Error("a different DPAPI entropy must not unwrap the data key")
	}
}
