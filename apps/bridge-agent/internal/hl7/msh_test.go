// AG-T07 tests: HL7 MSH parsing (02-TRD §5.4). AC-07.2 (MSH-10 echo source), AC-07.4 (MSH unparseable).
//
// Contract expected from package hl7 (names are the tester's; the spec fixes only files and TRD §5.4 positions):
//
//	var ErrMSHUnparseable error
//	type MSH struct {
//	    FieldSep byte
//	    Encoding string // MSH-2, e.g. `^~\&`
//	    SendingApp, SendingFacility, ReceivingApp, ReceivingFacility string // MSH-3..6
//	    DateTime, MessageType, ControlID, Version string                    // MSH-7, 9, 10, 12
//	    AcceptAckType, AppAckType string                                    // MSH-15, 16
//	}
//	func ParseMSH(msg []byte) (MSH, error) // msg = message between MLLP blocks; error wraps ErrMSHUnparseable
package hl7_test

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/hl7"
)

const (
	origMsg = "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|MSG0001|P|2.5.1\r" +
		"PID|1||E26000000001\rOBX|1|NM|GLU||5.4|mmol/L|||||F\r"
	enhMsg = "MSH|^~\\&|ANALYZER|LAB|LIMS|AG-01|20261111110000||ORU^R01|MSG0002|P|2.5.1|||AL|NE\r" +
		"PID|1||E26000000002\r"
)

func TestParseMSHOriginalMode(t *testing.T) {
	m, err := hl7.ParseMSH([]byte(origMsg))
	if err != nil {
		t.Fatal(err)
	}
	want := hl7.MSH{
		FieldSep: '|', Encoding: `^~\&`,
		SendingApp: "ANALYZER", SendingFacility: "LAB", ReceivingApp: "LIMS", ReceivingFacility: "AG-01",
		DateTime: "20261111110000", MessageType: "ORU^R01", ControlID: "MSG0001", Version: "2.5.1",
	}
	if m != want {
		t.Errorf("got %+v\nwant %+v", m, want)
	}
}

func TestParseMSHEnhancedModeFields(t *testing.T) {
	m, err := hl7.ParseMSH([]byte(enhMsg))
	if err != nil {
		t.Fatal(err)
	}
	if m.ControlID != "MSG0002" || m.AcceptAckType != "AL" || m.AppAckType != "NE" {
		t.Errorf("got %+v", m)
	}
}

func TestParseMSHShortButValid(t *testing.T) {
	// Only MSH-1..MSH-10 present, no trailing CR: still parseable, later fields empty.
	m, err := hl7.ParseMSH([]byte("MSH|^~\\&|A|B|C|D|2026||ORU^R01|ID1"))
	if err != nil {
		t.Fatal(err)
	}
	if m.ControlID != "ID1" || m.Version != "" || m.AcceptAckType != "" || m.AppAckType != "" {
		t.Errorf("got %+v", m)
	}
}

func TestParseMSHFieldSeparatorIsFourthByte(t *testing.T) {
	m, err := hl7.ParseMSH([]byte("MSH#^~\\&#A#B#C#D#2026##ORU^R01#ID9#P#2.3\rPID#1\r"))
	if err != nil {
		t.Fatal(err)
	}
	if m.FieldSep != '#' || m.ControlID != "ID9" || m.Version != "2.3" || m.SendingApp != "A" {
		t.Errorf("got %+v", m)
	}
}

func TestParseMSHOnlyReadsFirstSegment(t *testing.T) {
	// MSH-10 look-alikes in later segments must not leak into the result.
	m, err := hl7.ParseMSH([]byte("MSH|^~\\&|A|B|C|D|2026||ORU^R01|REAL|P|2.5\rMSH|^~\\&|X|X|X|X|X||X|FAKE|P|2.5\r"))
	if err != nil {
		t.Fatal(err)
	}
	if m.ControlID != "REAL" {
		t.Errorf("ControlID = %q", m.ControlID)
	}
}

// AC-07.4: an MSH that cannot be parsed → error (the session then sends no ACK and stores `incomplete`).
func TestParseMSHUnparseable(t *testing.T) {
	cases := map[string]string{
		"nil/empty":              "",
		"only MSH":               "MSH",
		"only MSH and separator": "MSH|",
		"no MSH-10 at all":       "MSH|^~\\&|A|B|C|D|2026||ORU^R01\r",
		"empty MSH-10":           "MSH|^~\\&|A|B|C|D|2026||ORU^R01||P|2.5\r",
		"first segment not MSH":  "PID|1||E26000000001\rMSH|^~\\&|A|B|C|D|2026||ORU^R01|ID1|P|2.5\r",
		"lowercase msh":          "msh|^~\\&|A|B|C|D|2026||ORU^R01|ID1|P|2.5\r",
		"binary garbage":         "\x00\x01\x02\xff\xfe",
		"plain text":             "hello world, this is not HL7\r",
		"ASTM text":              "H|\\^&|||SIM^0.1|||||||P|1\rL|1|N\r",
	}
	for name, in := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := hl7.ParseMSH([]byte(in))
			if !errors.Is(err, hl7.ErrMSHUnparseable) {
				t.Fatalf("err = %v, want ErrMSHUnparseable", err)
			}
		})
	}
	if _, err := hl7.ParseMSH(nil); !errors.Is(err, hl7.ErrMSHUnparseable) {
		t.Errorf("nil input: err = %v", err)
	}
}

// Security (07-SECURITY AB9/S-08): hostile input must never panic.
func TestParseMSHHostileDoesNotPanic(t *testing.T) {
	big := "MSH|^~\\&|" + strings.Repeat("A", 1<<20) + "|B|C|D|2026||ORU^R01|ID1|P|2.5\r"
	inputs := []string{
		big,
		"MSH|^~\\&|" + strings.Repeat("|", 100000),
		"MSH|^~\\&|A|B|C|D|2026||" + strings.Repeat("^", 100000) + "|ID1\r",
		"MSH|^~\\&|A|B|C|D|2026||ORU^R01|\xff\xfe\xfd|P|2.5\r",
		"MSH" + strings.Repeat("\r", 1000),
		"MSH\x00^~\\&\x00A",
	}
	for i, in := range inputs {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("input %d panicked: %v", i, r)
				}
			}()
			m, err := hl7.ParseMSH([]byte(in))
			if err == nil && m.ControlID == "" {
				t.Errorf("input %d: nil error with empty ControlID", i)
			}
		}()
	}
}

func FuzzParseMSH(f *testing.F) {
	f.Add([]byte(origMsg))
	f.Add([]byte(enhMsg))
	f.Add([]byte("MSH"))
	f.Add([]byte("MSH|^~\\&|A|B|C|D|2026||ORU^R01|ID1"))
	f.Add(bytes.Repeat([]byte("MSH|"), 50))
	f.Fuzz(func(t *testing.T, in []byte) {
		m, err := hl7.ParseMSH(in)
		if err == nil && m.ControlID == "" {
			t.Fatalf("nil error but empty ControlID for %q", in)
		}
		if err != nil && !errors.Is(err, hl7.ErrMSHUnparseable) {
			t.Fatalf("unexpected error type: %v", err)
		}
	})
}
