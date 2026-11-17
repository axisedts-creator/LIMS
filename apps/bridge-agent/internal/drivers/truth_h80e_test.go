package drivers

// H80-T01 tests (tester, written first). Spec: 08-ADDENDUM-TRUTH-H80E §7, CR-C7-016; LD-139.
//
// Contract the implementation must satisfy (additions to SessionProfile, profile.go):
//
//	ReplyAckPolicy         string // "each" | "last" | "none"; "" behaves as "each" (today's behaviour)
//	ReplyAckMatchControlId bool   // false = accept an ACK whatever its MSA-2 says
//
// and a registered profile "truth_h80e" (protocol hl7v2). Every other profile keeps today's values.

import (
	"reflect"
	"testing"
	"time"
)

func TestH80E_ProfileIsRegisteredAsInAddendumSection7(t *testing.T) {
	r := Resolve("truth_h80e", "hl7v2")
	if !r.Known || r.HeartbeatError != "" {
		t.Fatalf("truth_h80e: Known=%v HeartbeatError=%q, want a known, silent profile", r.Known, r.HeartbeatError)
	}
	p := r.Profile
	if p.Code != "truth_h80e" || p.Protocol != "hl7v2" {
		t.Errorf("Code/Protocol = %q/%q", p.Code, p.Protocol)
	}
	if p.HL7AckMode != "original" {
		t.Errorf("HL7AckMode = %q, want original (08-ADDENDUM §7)", p.HL7AckMode)
	}
	if !reflect.DeepEqual(p.HostQueryMessageTypes, []string{"QRY^Q02"}) {
		t.Errorf("HostQueryMessageTypes = %v, want [QRY^Q02]", p.HostQueryMessageTypes)
	}
	if !p.ExpectAckOnReply {
		t.Errorf("ExpectAckOnReply = false, want true")
	}
	if p.ReplyAckPolicy != "last" {
		t.Errorf("ReplyAckPolicy = %q, want last (QCK, DSR, then wait for ACK^Q03)", p.ReplyAckPolicy)
	}
	if p.ReplyAckMatchControlId {
		t.Errorf("ReplyAckMatchControlId = true, want false (the manual's ACK^Q03 echoes the query id, not the DSR id)")
	}
	if p.ReplyTimeout != 10*time.Second {
		t.Errorf("ReplyTimeout = %v, want 10s (U: a default, see addendum §7)", p.ReplyTimeout)
	}
	if p.ASTMDefaults != nil {
		t.Errorf("an HL7 profile carries no ASTM timers")
	}
}

// Wrong protocol must not hand out the HL7 profile (same rule as every registered code).
func TestH80E_WrongProtocolIsTreatedAsUnknown(t *testing.T) {
	for _, proto := range []string{"astm", "file_drop", "", "HL7V2"} {
		r := Resolve("truth_h80e", proto)
		if r.Known || r.HeartbeatError != ProfileUnknownCode {
			t.Errorf("proto %q: Known=%v err=%q, want unknown+reported", proto, r.Known, r.HeartbeatError)
		}
		if r.Profile.Code == "truth_h80e" {
			t.Errorf("proto %q: handed out the truth_h80e profile", proto)
		}
	}
}

// Near-miss codes never fall onto the host-query profile (host query stays inert for unknown drivers).
func TestH80E_NearMissCodesFallBackToGenericHL7(t *testing.T) {
	for _, code := range []string{"truth_h80", "TRUTH_H80E", "truth_h80e ", "truth-h80e", "truth_h80e\x00"} {
		r := Resolve(code, "hl7v2")
		if r.Known || r.Profile.Code != "hl7v2_generic_oru" || len(r.Profile.HostQueryMessageTypes) != 0 {
			t.Errorf("code %q: Known=%v profile=%q hostq=%v, want generic hl7 without host query",
				code, r.Known, r.Profile.Code, r.Profile.HostQueryMessageTypes)
		}
	}
}

// "new SessionProfile fields keep today's behaviour by default": every other profile leaves them at the zero value
// (or the explicit "each"), and nothing else about them changed.
func TestH80E_OtherProfilesKeepTodaysBehaviour(t *testing.T) {
	for _, code := range Codes() {
		if code == "truth_h80e" || code == "getein_metis" {
			continue
		}
		proto := map[string]string{"astm_generic_e1394": "astm", "file_drop_generic": "file_drop"}[code]
		if proto == "" {
			proto = "hl7v2"
		}
		p := Resolve(code, proto).Profile
		if p.ReplyAckPolicy != "" && p.ReplyAckPolicy != "each" {
			t.Errorf("%s: ReplyAckPolicy = %q, want \"\" or each", code, p.ReplyAckPolicy)
		}
		if p.ReplyAckMatchControlId {
			t.Errorf("%s: ReplyAckMatchControlId must default to false", code)
		}
		if p.ExpectAckOnReply {
			t.Errorf("%s: ExpectAckOnReply changed from today's false", code)
		}
	}
	// the two sketches keep their exact host-query types
	if got := Resolve("mindray_bs200_sketch", "hl7v2").Profile.HostQueryMessageTypes; !reflect.DeepEqual(got, []string{"QRY^Q02"}) {
		t.Errorf("bs200 sketch changed: %v", got)
	}
	if got := Resolve("mindray_bc5380_sketch", "hl7v2").Profile.HostQueryMessageTypes; !reflect.DeepEqual(got, []string{"ORM^O01"}) {
		t.Errorf("bc5380 sketch changed: %v", got)
	}
}

// Only the three documented policy values may ever be registered.
func TestH80E_EveryRegisteredPolicyIsADocumentedValue(t *testing.T) {
	for _, code := range Codes() {
		proto := map[string]string{"astm_generic_e1394": "astm", "file_drop_generic": "file_drop"}[code]
		if proto == "" {
			proto = "hl7v2"
		}
		switch p := Resolve(code, proto).Profile.ReplyAckPolicy; p {
		case "", "each", "last", "none":
		default:
			t.Errorf("%s: ReplyAckPolicy = %q, want each|last|none", code, p)
		}
	}
}

func TestH80E_ResolveReturnsIndependentCopy(t *testing.T) {
	a := Resolve("truth_h80e", "hl7v2").Profile
	a.HostQueryMessageTypes[0] = "EVIL^X01"
	a.ReplyAckPolicy = "none"
	a.ReplyAckMatchControlId = true
	a.ReplyTimeout = time.Hour
	b := Resolve("truth_h80e", "hl7v2").Profile
	if b.HostQueryMessageTypes[0] != "QRY^Q02" || b.ReplyAckPolicy != "last" || b.ReplyAckMatchControlId || b.ReplyTimeout != 10*time.Second {
		t.Fatalf("mutation leaked into the registry: %+v", b)
	}
}

func TestH80E_ResolveConcurrentSafe(t *testing.T) {
	done := make(chan struct{})
	for i := 0; i < 16; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 200; j++ {
				r := Resolve("truth_h80e", "hl7v2")
				r.Profile.HostQueryMessageTypes[0] = "x"
				r.Profile.ReplyAckPolicy = "none"
			}
		}()
	}
	for i := 0; i < 16; i++ {
		<-done
	}
	if p := Resolve("truth_h80e", "hl7v2").Profile; p.HostQueryMessageTypes[0] != "QRY^Q02" || p.ReplyAckPolicy != "last" {
		t.Fatalf("corrupted under concurrency: %+v", p)
	}
}
