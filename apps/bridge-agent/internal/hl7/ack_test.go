// AG-T07 tests: HL7 ACK building and code selection (02-TRD §5.4). AC-07.2, AC-07.3.
//
// Contract expected from package hl7:
//
//	// AckCode picks the MSA-1 code. mode ∈ auto|original|enhanced|none. committed=false → queue write failed.
//	// send=false means no ACK is written at all (mode none).
//	func AckCode(m MSH, mode string, committed bool) (code string, send bool)
//
//	type AckOptions struct {
//	    SendingApp      string    // default "LIMS" when empty
//	    SendingFacility string    // default: the agent code (caller supplies)
//	    TypeFormat      string    // "ACK" (default when empty) | "ACK^{trigger}^ACK"
//	    Now             time.Time // formatted YYYYMMDDHHMMSS in Now's own location
//	    ControlID       string    // new MSH-10 of the ACK
//	}
//	// BuildACK returns the two-segment ACK (each segment CR-terminated), WITHOUT MLLP framing.
//	func BuildACK(m MSH, code string, o AckOptions) []byte
package hl7_test

import (
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hl7"
)

var ackNow = time.Date(2026, 11, 11, 11, 42, 0, 0, time.UTC)

func parse(t *testing.T, s string) hl7.MSH {
	t.Helper()
	m, err := hl7.ParseMSH([]byte(s))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func opts(format string) hl7.AckOptions {
	return hl7.AckOptions{SendingApp: "LIMS", SendingFacility: "AG-01", TypeFormat: format, Now: ackNow, ControlID: "ACKID1"}
}

func TestAckCodeTable(t *testing.T) {
	orig, enh := parse(t, origMsg), parse(t, enhMsg)
	cases := []struct {
		name      string
		m         hl7.MSH
		mode      string
		committed bool
		code      string
		send      bool
	}{
		{"auto original committed", orig, "auto", true, "AA", true},
		{"auto original queue failed", orig, "auto", false, "AR", true},
		{"auto enhanced committed", enh, "auto", true, "CA", true},
		{"auto enhanced queue failed", enh, "auto", false, "CR", true},
		{"empty mode behaves as auto", orig, "", true, "AA", true},
		{"forced original on enhanced msg", enh, "original", true, "AA", true},
		{"forced original failed", enh, "original", false, "AR", true},
		{"forced enhanced on original msg", orig, "enhanced", true, "CA", true},
		{"forced enhanced failed", orig, "enhanced", false, "CR", true},
		{"none committed", orig, "none", true, "", false},
		{"none failed", enh, "none", false, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			code, send := hl7.AckCode(c.m, c.mode, c.committed)
			if code != c.code || send != c.send {
				t.Errorf("got (%q,%v) want (%q,%v)", code, send, c.code, c.send)
			}
		})
	}
}

// AC-07.2: MSA-1 = AA, MSA-2 = MSH-10 of the message; exact layout from TRD §5.4.
func TestBuildACKOriginalExact(t *testing.T) {
	got := string(hl7.BuildACK(parse(t, origMsg), "AA", opts("ACK")))
	want := "MSH|^~\\&|LIMS|AG-01|ANALYZER|LAB|20261111114200||ACK|ACKID1|P|2.5.1\r" +
		"MSA|AA|MSG0001\r"
	if got != want {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

// AC-07.3 enhanced mode: CA (commit accept), CR on failure.
func TestBuildACKEnhancedCodes(t *testing.T) {
	m := parse(t, enhMsg)
	for _, code := range []string{"CA", "CR", "AR", "AE"} {
		got := string(hl7.BuildACK(m, code, opts("ACK")))
		want := "MSH|^~\\&|LIMS|AG-01|ANALYZER|LAB|20261111114200||ACK|ACKID1|P|2.5.1\rMSA|" + code + "|MSG0002\r"
		if got != want {
			t.Errorf("%s: got %q want %q", code, got, want)
		}
	}
}

func TestBuildACKTypeFormatWithTrigger(t *testing.T) {
	got := string(hl7.BuildACK(parse(t, origMsg), "AA", opts("ACK^{trigger}^ACK")))
	if !strings.HasPrefix(got, "MSH|^~\\&|LIMS|AG-01|ANALYZER|LAB|20261111114200||ACK^R01^ACK|ACKID1|P|2.5.1\r") {
		t.Errorf("got %q", got)
	}
}

func TestBuildACKDefaultsSendingApp(t *testing.T) {
	o := opts("")
	o.SendingApp = ""
	got := string(hl7.BuildACK(parse(t, origMsg), "AA", o))
	if !strings.HasPrefix(got, "MSH|^~\\&|LIMS|AG-01|") {
		t.Errorf("sending app default not LIMS: %q", got)
	}
	if !strings.Contains(got, "||ACK|ACKID1|") {
		t.Errorf("empty TypeFormat should yield plain ACK: %q", got)
	}
}

func TestBuildACKRoundTripsThroughParser(t *testing.T) {
	ack := hl7.BuildACK(parse(t, origMsg), "AA", opts("ACK"))
	m, err := hl7.ParseMSH(ack)
	if err != nil {
		t.Fatal(err)
	}
	if m.ControlID != "ACKID1" || m.MessageType != "ACK" || m.ReceivingApp != "ANALYZER" || m.ReceivingFacility != "LAB" {
		t.Errorf("parsed ACK = %+v", m)
	}
	if n := strings.Count(string(ack), "\r"); n != 2 {
		t.Errorf("want exactly 2 CR terminators, got %d", n)
	}
}

func TestBuildACKNoFramingBytes(t *testing.T) {
	ack := hl7.BuildACK(parse(t, origMsg), "AA", opts("ACK"))
	if strings.ContainsAny(string(ack), "\x0b\x1c") {
		t.Errorf("ACK must not contain MLLP framing bytes: %q", ack)
	}
}
