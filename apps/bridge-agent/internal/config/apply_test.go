package config

// AG-T11 Apply (AC-15.1): reject => keep current config, report config_state in the next heartbeat.
// done_when: bad signature / wrong agent / rollback rejected AND reported. Equal version = no-op (5.10).

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func newApplier(t *testing.T, dir string) *Applier {
	t.Helper()
	a, err := NewApplier(dir, trusted(t), testAgentID)
	if err != nil {
		t.Fatalf("NewApplier: %v", err)
	}
	return a
}

func envV(t *testing.T, version int, code string) []byte {
	t.Helper()
	return signed(goldenPriv(t), testKeyID, docJSON(testAgentID, version, code))
}

func currentVersion(t *testing.T, a *Applier) (int, string) {
	t.Helper()
	raw, ok := a.Current()
	if !ok {
		t.Fatal("Current(): no applied config")
	}
	var d struct {
		V    int `json:"config_version"`
		Inst []struct {
			Code string `json:"instrument_code"`
		} `json:"instruments"`
	}
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatalf("Current() not JSON: %v", err)
	}
	code := ""
	if len(d.Inst) > 0 {
		code = d.Inst[0].Code
	}
	return d.V, code
}

func TestApply_Fresh_NothingApplied(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, ok := a.Current(); ok {
		t.Fatal("fresh applier must have no current config")
	}
	if r := a.Report(); r.ConfigVersionApplied != 0 || r.ConfigState != "" {
		t.Fatalf("fresh report = %+v", r)
	}
}

func TestApply_GoldenEnvelope_Applied(t *testing.T) {
	a := newApplier(t, t.TempDir())
	out, err := a.Apply(goldenEnvelope(t))
	if err != nil {
		t.Fatalf("golden rejected: %v", err)
	}
	if !out.Applied || out.NoOp || out.State != StateOK || out.ConfigVersion != 7 {
		t.Fatalf("outcome = %+v", out)
	}
	if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateOK {
		t.Fatalf("report = %+v", r)
	}
}

func TestApply_Report_JSONFieldNamesMatchHeartbeatSchema(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, err := a.Apply(envV(t, 2, "A")); err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(a.Report())
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m["config_version_applied"] != float64(2) || m["config_state"] != "ok" {
		t.Fatalf("heartbeat fields = %s (05-SCHEMA agent_status.config_version_applied/config_state)", b)
	}
}

func TestApply_BadSignature_RejectedKeptAndReported(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)

	tampered := []byte(strings.Replace(string(envV(t, 9, "EVIL")), "EVIL", "EVI1", 1))
	out, err := a.Apply(tampered)
	wantState(t, err, StateSignatureInvalid)
	if out.Applied || out.State != StateSignatureInvalid {
		t.Fatalf("outcome = %+v", out)
	}
	if v, code := currentVersion(t, a); v != 7 || code != "KEEP" {
		t.Fatalf("current config changed to v%d %q", v, code)
	}
	if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateSignatureInvalid {
		t.Fatalf("report = %+v", r)
	}
	sameSnapshot(t, before, snapshot(t, dir))
}

func TestApply_WrongAgent_RejectedKeptAndReported(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)

	_, err := a.Apply(signed(goldenPriv(t), testKeyID, docJSON(otherAgentID, 9, "EVIL")))
	wantState(t, err, StateAgentMismatch)
	if v, code := currentVersion(t, a); v != 7 || code != "KEEP" {
		t.Fatalf("current config changed to v%d %q", v, code)
	}
	if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateAgentMismatch {
		t.Fatalf("report = %+v", r)
	}
	sameSnapshot(t, before, snapshot(t, dir))
}

func TestApply_Rollback_RejectedKeptAndReported(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)

	// a validly signed OLD config (replay of a captured response) must not win
	for _, v := range []int{6, 1} {
		out, err := a.Apply(envV(t, v, "OLD"))
		wantState(t, err, StateRollbackRejected)
		if out.Applied || out.State != StateRollbackRejected {
			t.Fatalf("v%d outcome = %+v", v, out)
		}
		if cv, code := currentVersion(t, a); cv != 7 || code != "KEEP" {
			t.Fatalf("current config changed to v%d %q", cv, code)
		}
		if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateRollbackRejected {
			t.Fatalf("report = %+v", r)
		}
	}
	sameSnapshot(t, before, snapshot(t, dir))
}

func TestApply_EqualVersion_IsNoOp_NotAnError(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(envV(t, 7, "FIRST")); err != nil {
		t.Fatal(err)
	}
	before := snapshot(t, dir)
	out, err := a.Apply(envV(t, 7, "SAMEVER")) // same version, different content: must not replace
	if err != nil {
		t.Fatalf("equal version must be a no-op, got %v", err)
	}
	if out.Applied || !out.NoOp || out.State != StateOK {
		t.Fatalf("outcome = %+v", out)
	}
	if _, code := currentVersion(t, a); code != "FIRST" {
		t.Fatalf("equal version replaced the config (%q)", code)
	}
	if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateOK {
		t.Fatalf("report = %+v", r)
	}
	sameSnapshot(t, before, snapshot(t, dir))
}

func TestApply_SchemaInvalid_RejectedKeptAndReported(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}
	bad := strings.Replace(docJSON(testAgentID, 8, "X"), "lims.bridge.config.v1", "lims.bridge.config.v2", 1)
	_, err := a.Apply(signed(goldenPriv(t), testKeyID, bad))
	wantState(t, err, StateSchemaInvalid)
	if v, _ := currentVersion(t, a); v != 7 {
		t.Fatalf("current config changed to v%d", v)
	}
	if r := a.Report(); r.ConfigVersionApplied != 7 || r.ConfigState != StateSchemaInvalid {
		t.Fatalf("report = %+v", r)
	}
}

func TestApply_ForgedHugeVersion_DoesNotAdvanceAnything(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}
	_, attacker := newKey(t, "attacker")
	_, err := a.Apply(signed(attacker, testKeyID, docJSON(testAgentID, 9007199254740991, "EVIL")))
	wantState(t, err, StateSignatureInvalid)
	// the lock-out attack (burn the version counter) must fail: a normal next version still applies
	if _, err := a.Apply(envV(t, 8, "NEXT")); err != nil {
		t.Fatalf("v8 after forged huge version: %v", err)
	}
}

func TestApply_RecoversAfterRejection_StateBackToOK(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, err := a.Apply(envV(t, 7, "A")); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Apply(envV(t, 3, "OLD")); err == nil {
		t.Fatal("rollback accepted")
	}
	if a.Report().ConfigState != StateRollbackRejected {
		t.Fatal("state not reported after rejection")
	}
	out, err := a.Apply(envV(t, 8, "B"))
	if err != nil || !out.Applied {
		t.Fatalf("v8: %v %+v", err, out)
	}
	if r := a.Report(); r.ConfigVersionApplied != 8 || r.ConfigState != StateOK {
		t.Fatalf("report = %+v", r)
	}
	if v, code := currentVersion(t, a); v != 8 || code != "B" {
		t.Fatalf("current = v%d %q", v, code)
	}
}

// Anti-rollback must survive an agent restart, otherwise a reboot + replayed old config bypasses AC-15.1.
func TestApply_AppliedVersionPersists_RollbackStillRejectedAfterRestart(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(envV(t, 7, "KEEP")); err != nil {
		t.Fatal(err)
	}

	b := newApplier(t, dir) // "restart"
	if r := b.Report(); r.ConfigVersionApplied != 7 {
		t.Fatalf("applied version not restored: %+v", r)
	}
	if v, code := currentVersion(t, b); v != 7 || code != "KEEP" {
		t.Fatalf("current not restored: v%d %q", v, code)
	}
	_, err := b.Apply(envV(t, 6, "OLD"))
	wantState(t, err, StateRollbackRejected)
	if out, err := b.Apply(envV(t, 7, "KEEP")); err != nil || !out.NoOp {
		t.Fatalf("equal version after restart: %v %+v", err, out)
	}
	if out, err := b.Apply(envV(t, 8, "NEW")); err != nil || !out.Applied {
		t.Fatalf("v8 after restart: %v %+v", err, out)
	}
}

func TestApply_Success_LeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	for v := 1; v <= 3; v++ {
		if _, err := a.Apply(envV(t, v, "A")); err != nil {
			t.Fatal(err)
		}
	}
	for name := range snapshot(t, dir) {
		low := strings.ToLower(name)
		if strings.HasSuffix(low, ".tmp") || strings.HasSuffix(low, ".part") || strings.HasSuffix(low, ".new") {
			t.Errorf("leftover temp file %s (apply must be atomic: write+rename)", filepath.Base(name))
		}
	}
}

func TestApply_NeverStoresSigningOrDeviceSecrets(t *testing.T) {
	dir := t.TempDir()
	a := newApplier(t, dir)
	if _, err := a.Apply(goldenEnvelope(t)); err != nil {
		t.Fatal(err)
	}
	for name, content := range snapshot(t, dir) {
		if strings.Contains(content, "PRIVATE KEY") {
			t.Errorf("%s contains key material", name)
		}
	}
}

func TestApply_Concurrent_NoLostUpdateOrTornState(t *testing.T) {
	a := newApplier(t, t.TempDir())
	if _, err := a.Apply(envV(t, 7, "A")); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(v int) {
			defer wg.Done()
			_, err := a.Apply(envV(t, v, "C"))
			if err != nil {
				var ce *Error
				if !errors.As(err, &ce) || ce.State != StateRollbackRejected {
					t.Errorf("v%d: unexpected error %v", v, err)
				}
			}
			_ = a.Report()
			_, _ = a.Current()
		}(8 + i)
	}
	wg.Wait()
	if v, _ := currentVersion(t, a); v != 27 {
		t.Fatalf("current version = %d, want 27 (highest wins)", v)
	}
	if a.Report().ConfigVersionApplied != 27 {
		t.Fatalf("report = %+v", a.Report())
	}
}

func TestApply_MalformedInput_RejectedNeverPanics(t *testing.T) {
	a := newApplier(t, t.TempDir())
	for _, in := range [][]byte{nil, []byte(``), []byte(`null`), []byte(`{}`), []byte(`garbage`), goldenEnvelope(t)[:30]} {
		out, err := a.Apply(in)
		if err == nil || out.Applied {
			t.Errorf("accepted %q", in)
			continue
		}
		var ce *Error
		if !errors.As(err, &ce) || !isRejectState(ce.State) {
			t.Errorf("%q: want a reject *Error, got %v", in, err)
		}
	}
	if _, ok := a.Current(); ok {
		t.Fatal("garbage produced a current config")
	}
}
