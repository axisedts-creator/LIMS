package simulator_test

// MET-T01 simulator sessions (tester, written first): 09-ADDENDUM-GETEIN-METIS §2-§7, LD-163, PRD AC-10.6.
// The writer creates apps/bridge-agent/testdata/sessions/<name>.session.json for the eight sessions below, and makes
// the simulator build the §6 ACK form from the registered profile getein_metis (profile field HL7AckFullForm, see
// drivers/getein_metis_test.go). These tests pin: the files exist, name the profile, run green against the real link
// layers, and carry the messages and the exact ACK bytes that make each scenario what it claims to be.
//
// Synthetic-data rule (TestSessionsSyntheticDataOnly, unchanged): no digit run of 10+ outside E26nnnnnnnn barcodes,
// so MSH-7 / QRD-1 timestamps must be short (e.g. 20261114); barcodes look like MT2600000042 (letters glue the digits
// to a word boundary, so they pass), patient id V000123, name Test Patient.
// Run: go test ./internal/simulator/ -run Metis

import (
	"regexp"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/simulator"
)

var metisSessions = []string{
	"metis-oru-patient",         // ORU^R01 MSH-16 0, id 57 -> committed, AA echoing id/version/MSH-16, queued kind=data
	"metis-oru-qc",              // ORU^R01 MSH-16 2, id 58 -> same, MSH-16 2 echoed
	"metis-oru-calibration",     // ORU^R01 MSH-16 1, id 59 -> archived like any ORU (D-MET-2), AA with MSH-16 1
	"metis-qry-found",           // QRY^Q02 -> QCK OK, DSR written at once, ACK^Q03 consumed
	"metis-qry-not-found",       // QRY^Q02 unknown barcode -> QCK NF only
	"metis-qry-sample-range-nf", // QRY^Q02 mode (b), QRD-8 empty, QRF-4/5 set -> QCK NF only (D-MET-1)
	"metis-q03-id-mismatch",     // ACK^Q03 MSA-2 differs from the DSR id -> accepted
	"metis-api-down",            // API unreachable -> the agent writes nothing to the query (AC-10.6); results still AA
}

// ackFor is the exact §6 ACK bytes as a session file spells them: {now} is the simulator clock, <CR> the segment end.
func ackFor(id, m16 string) string {
	return "MSH|^~\\&|LIS|LIMS|||{now}||ACK^R01|" + id + "|P|2.3.1||||" + m16 + "||UTF8|||<CR>MSA|AA|" + id + "|Message accepted|||0|<CR>"
}

func TestMetis_SessionsExistNameTheProfileAndRunGreen(t *testing.T) {
	for _, n := range metisSessions {
		n := n
		t.Run(n, func(t *testing.T) {
			rs, _ := readRaw(t, n)
			if rs.Name != n || rs.Protocol != "hl7v2" || rs.Transport != "tcp_server" {
				t.Fatalf("name/protocol/transport = %q/%q/%q, want %q/hl7v2/tcp_server (D-MET-3)", rs.Name, rs.Protocol, rs.Transport, n)
			}
			s, err := simulator.LoadSession(sessionsDir + "/" + n + ".session.json")
			if err != nil {
				t.Fatalf("LoadSession: %v", err)
			}
			if s.InstrumentProfile != "getein_metis" {
				t.Errorf("instrument_profile = %q, want getein_metis", s.InstrumentProfile)
			}
			if err := simulator.Run(s, t.TempDir()); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMetis_SessionContent(t *testing.T) {
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

	// done criterion: the ACK to an ORU echoes MSH-10, MSH-12, MSH-16 of the original and carries MSH-18 UTF8, byte for byte.
	has("metis-oru-patient", "ORU^R01|57|P|2.3.1||||0||UTF8", "OBR|1|MT26", ackFor("57", "0"), "kind=data")
	has("metis-oru-qc", "ORU^R01|58|P|2.3.1||||2||UTF8", ackFor("58", "2"), "kind=data")
	has("metis-oru-calibration", "ORU^R01|59|P|2.3.1||||1||UTF8", ackFor("59", "1"), "kind=data") // archived, never dropped (D-MET-2)
	lacks("metis-oru-qc", "PID|")                                                                  // a QC message has no PID (addendum §4)

	has("metis-qry-found", "QRY^Q02", "QCK^Q02", "QAK|SR|OK|", "DSR^Q03", "ACK^Q03",
		"MSA|AA|61|Message accepted|||0|<CR>ERR|0|<CR>QAK|SR|OK|<CR>", // the manual's QCK, trailing pipe on every segment
		"DSC||<CR>")
	if _, all := readRaw(t, "metis-qry-found"); strings.Index(all, "QCK^Q02") > strings.Index(all, "DSR^Q03") {
		t.Errorf("metis-qry-found: the QCK must come before the DSR")
	}
	lacks("metis-qry-found", "ACK^R01") // a host query gets no ACK of its own

	for _, n := range []string{"metis-qry-not-found", "metis-qry-sample-range-nf"} {
		has(n, "QRY^Q02", "QCK^Q02", "QAK|SR|NF|")
		lacks(n, "DSR^Q03", "QAK|SR|OK", "ACK^R01")
	}
	// mode (b): QRD-8 empty, QRF-4 and QRF-5 carry the sample-number range (addendum §5)
	has("metis-qry-sample-range-nf", "|RD||OTH|", "QRF||||")
	lacks("metis-qry-sample-range-nf", "|RD|MT26")

	has("metis-q03-id-mismatch", "DSR^Q03", "ACK^Q03")
	_, all := readRaw(t, "metis-q03-id-mismatch")
	dsr := regexp.MustCompile(`DSR\^Q03\|([^|]+)\|`).FindStringSubmatch(all)
	ack := regexp.MustCompile(`ACK\^Q03\|[^|]*\|[^<]*<CR>MSA\|AA\|([^|]+)\|`).FindStringSubmatch(all)
	if dsr == nil || ack == nil {
		t.Fatalf("metis-q03-id-mismatch: cannot find the DSR MSH-10 (%v) and the ACK^Q03 MSA-2 (%v)", dsr, ack)
	}
	if dsr[1] == ack[1] {
		t.Errorf("metis-q03-id-mismatch: ACK^Q03 MSA-2 = DSR MSH-10 = %q; the session must make them differ (addendum §6, M8)", dsr[1])
	}

	has("metis-api-down", "QRY^Q02", "expect_queue", ackFor("57", "0")) // the ORU after the outage still gets the Metis ACK
	lacks("metis-api-down", "QCK^Q02", "DSR^Q03", "QAK|SR")             // the agent invents no reply
}

// Scenarios must differ: a copy-pasted session proves nothing.
func TestMetis_SessionsAreDistinct(t *testing.T) {
	seen := map[string]string{}
	for _, n := range metisSessions {
		_, all := readRaw(t, n)
		if prev, dup := seen[all]; dup {
			t.Errorf("%s and %s carry identical steps", prev, n)
		}
		seen[all] = n
	}
}

// No patient name, birth date or sex copied anywhere except the instrument's own synthetic ORU/DSR bytes (LD-163),
// and only the synthetic ones: "Test Patient", patient id V000123.
func TestMetis_SessionsCarryOnlySyntheticIdentity(t *testing.T) {
	real := regexp.MustCompile(`PID\|[^<]*\|([A-Za-z]+ [A-Za-z]+)\|`)
	for _, n := range metisSessions {
		_, all := readRaw(t, n)
		for _, m := range real.FindAllStringSubmatch(all, -1) {
			if m[1] != "Test Patient" {
				t.Errorf("%s: patient name %q is not the synthetic \"Test Patient\"", n, m[1])
			}
		}
	}
}
