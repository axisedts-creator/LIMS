package simulator_test

// H80-T01 simulator sessions (tester, written first): 08-ADDENDUM-TRUTH-H80E §5-§7, LD-139, PRD AC-10.6.
// The writer creates apps/bridge-agent/testdata/sessions/<name>.session.json (and the simulator support an hl7v2
// host-query step needs). These tests pin: the six files exist, name the profile, run green against the real link
// layers, and carry the messages that make each scenario what it claims to be.
//
// Synthetic-data rule (TestSessionsSyntheticDataOnly, unchanged): no digit run of 10+ outside E26nnnnnnnn barcodes,
// so MSH-7 / QRD-1 timestamps must be short (e.g. 20261105) and patient ids like P0000123.
// Run: go test ./internal/simulator/ -run H80E

import (
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/simulator"
)

var h80eSessions = []string{
	"h80e-oru-patient",       // ORU^R01 patient result -> AA, queued kind=data
	"h80e-qry-found",         // QRY^Q02 -> QCK OK, DSR written at once, ACK^Q03 consumed
	"h80e-qry-not-found",     // QRY^Q02 unknown barcode -> QCK NF only
	"h80e-qry-no-order-nf",   // known tube, no HbA1c order pending -> QCK NF only
	"h80e-q03-id-mismatch",   // ACK^Q03 MSA-2 = query id (126) not DSR id (12602) -> accepted
	"h80e-api-down",          // API unreachable -> the agent writes nothing (AC-10.6)
}

func TestH80E_SessionsExistNameTheProfileAndRunGreen(t *testing.T) {
	for _, n := range h80eSessions {
		n := n
		t.Run(n, func(t *testing.T) {
			rs, _ := readRaw(t, n)
			if rs.Name != n || rs.Protocol != "hl7v2" || rs.Transport == "" {
				t.Fatalf("name/protocol/transport = %q/%q/%q, want %q/hl7v2/non-empty", rs.Name, rs.Protocol, rs.Transport, n)
			}
			s, err := simulator.LoadSession(sessionsDir + "/" + n + ".session.json")
			if err != nil {
				t.Fatalf("LoadSession: %v", err)
			}
			if s.InstrumentProfile != "truth_h80e" {
				t.Errorf("instrument_profile = %q, want truth_h80e", s.InstrumentProfile)
			}
			if err := simulator.Run(s, t.TempDir()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestH80E_SessionContent(t *testing.T) {
	has := func(name string, wants ...string) {
		t.Helper()
		_, all := readRaw(t, name)
		for _, w := range wants {
			if !strings.Contains(all, w) {
				t.Errorf("%s: session must contain %q", name, w)
			}
		}
	}
	lacks := func(name string, nots ...string) {
		t.Helper()
		_, all := readRaw(t, name)
		for _, w := range nots {
			if strings.Contains(all, w) {
				t.Errorf("%s: session must NOT contain %q", name, w)
			}
		}
	}
	has("h80e-oru-patient", "ORU^R01", "MSA|AA|", "kind=data", "OBR|1|0001|E26")

	has("h80e-qry-found", "QRY^Q02", "QCK^Q02", "QAK|SR|OK", "DSR^Q03", "ACK^Q03")
	if _, all := readRaw(t, "h80e-qry-found"); strings.Index(all, "QCK^Q02") > strings.Index(all, "DSR^Q03") {
		t.Errorf("h80e-qry-found: the QCK must come before the DSR")
	}

	for _, n := range []string{"h80e-qry-not-found", "h80e-qry-no-order-nf"} {
		has(n, "QRY^Q02", "QCK^Q02", "QAK|SR|NF")
		lacks(n, "DSR^Q03", "QAK|SR|OK")
	}

	has("h80e-q03-id-mismatch", "DSR^Q03", "12602", "ACK^Q03", "MSA|AA|126|")

	has("h80e-api-down", "QRY^Q02", "expect_queue")
	lacks("h80e-api-down", "QCK^Q02", "DSR^Q03", "QAK|SR") // the agent invents no reply
}

// Scenarios must differ: a copy-pasted session proves nothing.
func TestH80E_SessionsAreDistinct(t *testing.T) {
	seen := map[string]string{}
	for _, n := range h80eSessions {
		_, all := readRaw(t, n)
		if prev, dup := seen[all]; dup {
			t.Errorf("%s and %s carry identical steps", prev, n)
		}
		seen[all] = n
	}
}
