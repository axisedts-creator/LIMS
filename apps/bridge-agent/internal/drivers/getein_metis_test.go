package drivers

// MET-T01 tests (tester, written first). Spec: 09-ADDENDUM-GETEIN-METIS §6-§7; binding lead decision LD-163
// (the addendum header calls it LD-162; LD-163 is the binding number). Run: go test ./internal/drivers/ -run Metis
//
// Contract the implementation must satisfy: a registered profile "getein_metis" (protocol hl7v2) built on the
// CR-C7-016 fields, plus ONE new opt-in field (the addendum §7 literal has no field for the §6 ACK form, which differs
// from H80E's short ACK, so a field is needed; ASSUMPTION flagged in .orchestra/notes/MET-T01-tests.md):
//
//	HL7AckFullForm bool // true: ACK built per 09-ADDENDUM §6 (MSH-16 echoed, MSH-18 UTF8, MSA text + error code). false = today's.
//
// Every other profile keeps today's values.

import (
	"reflect"
	"testing"
	"time"
)

func TestMetis_ProfileIsRegisteredAsInAddendumSection7(t *testing.T) {
	r := Resolve("getein_metis", "hl7v2")
	if !r.Known || r.HeartbeatError != "" {
		t.Fatalf("getein_metis: Known=%v HeartbeatError=%q, want a known, silent profile", r.Known, r.HeartbeatError)
	}
	p := r.Profile
	if p.Code != "getein_metis" || p.Protocol != "hl7v2" {
		t.Errorf("Code/Protocol = %q/%q", p.Code, p.Protocol)
	}
	if p.HL7AckMode != "original" {
		t.Errorf("HL7AckMode = %q, want original (the ACK echoes the ORU's own MSH-12, 09-ADDENDUM §7)", p.HL7AckMode)
	}
	if !reflect.DeepEqual(p.HostQueryMessageTypes, []string{"QRY^Q02"}) {
		t.Errorf("HostQueryMessageTypes = %v, want [QRY^Q02]", p.HostQueryMessageTypes)
	}
	if !p.ExpectAckOnReply {
		t.Errorf("ExpectAckOnReply = false, want true")
	}
	if p.ReplyAckPolicy != "last" {
		t.Errorf("ReplyAckPolicy = %q, want last (QCK, DSR at once, then wait for ACK^Q03)", p.ReplyAckPolicy)
	}
	if p.ReplyAckMatchControlId {
		t.Errorf("ReplyAckMatchControlId = true, want false (an ACK^Q03 whose MSA-2 differs must be accepted, addendum §6)")
	}
	if p.ReplyTimeout != 10*time.Second {
		t.Errorf("ReplyTimeout = %v, want 10s (U7: a default, overridable per instrument)", p.ReplyTimeout)
	}
	if !p.HL7AckFullForm {
		t.Errorf("HL7AckFullForm = false, want true (§6 ACK: MSH-16 echoed, MSH-18 UTF8, MSA text and code)")
	}
	if p.ASTMDefaults != nil {
		t.Errorf("an HL7 profile carries no ASTM timers")
	}
}

func TestMetis_WrongProtocolIsTreatedAsUnknown(t *testing.T) {
	for _, proto := range []string{"astm", "file_drop", "", "HL7V2"} {
		r := Resolve("getein_metis", proto)
		if r.Known || r.HeartbeatError != ProfileUnknownCode {
			t.Errorf("proto %q: Known=%v err=%q, want unknown+reported", proto, r.Known, r.HeartbeatError)
		}
		if r.Profile.Code == "getein_metis" {
			t.Errorf("proto %q: handed out the getein_metis profile", proto)
		}
	}
}

// Near-miss codes never land on the host-query profile (host query stays inert for unknown drivers).
func TestMetis_NearMissCodesFallBackToGenericHL7(t *testing.T) {
	for _, code := range []string{"getein", "GETEIN_METIS", "getein_metis ", "getein-metis", "getein_metis\x00", "metis", "getein_metis_6000"} {
		r := Resolve(code, "hl7v2")
		if r.Known || r.Profile.Code != "hl7v2_generic_oru" || len(r.Profile.HostQueryMessageTypes) != 0 || r.Profile.HL7AckFullForm {
			t.Errorf("code %q: Known=%v profile=%q hostq=%v fullForm=%v, want generic hl7 without host query",
				code, r.Known, r.Profile.Code, r.Profile.HostQueryMessageTypes, r.Profile.HL7AckFullForm)
		}
	}
}

// "no existing profile or test changes behaviour": the new field is false everywhere else, and truth_h80e is exactly as H80-T01 left it.
func TestMetis_NoOtherProfileChanged(t *testing.T) {
	for _, code := range Codes() {
		if code == "getein_metis" {
			continue
		}
		proto := map[string]string{"astm_generic_e1394": "astm", "file_drop_generic": "file_drop"}[code]
		if proto == "" {
			proto = "hl7v2"
		}
		if Resolve(code, proto).Profile.HL7AckFullForm {
			t.Errorf("%s: HL7AckFullForm must default to false (today's ACK)", code)
		}
	}
	want := SessionProfile{Code: "truth_h80e", Protocol: "hl7v2", HL7AckMode: "original",
		HostQueryMessageTypes: []string{"QRY^Q02"}, ExpectAckOnReply: true,
		ReplyAckPolicy: "last", ReplyAckMatchControlId: false, ReplyTimeout: 10 * time.Second}
	if got := Resolve("truth_h80e", "hl7v2").Profile; !reflect.DeepEqual(got, want) {
		t.Errorf("truth_h80e changed:\n got %+v\nwant %+v", got, want)
	}
	if got := Resolve("hl7v2_generic_oru", "hl7v2").Profile; got.HL7AckMode != "auto" || got.HL7AckMessageTypeFormat != "ACK" || got.ExpectAckOnReply || len(got.HostQueryMessageTypes) != 0 {
		t.Errorf("hl7v2_generic_oru changed: %+v", got)
	}
	if got := Resolve("mindray_bs200_sketch", "hl7v2").Profile.HostQueryMessageTypes; !reflect.DeepEqual(got, []string{"QRY^Q02"}) {
		t.Errorf("bs200 sketch changed: %v", got)
	}
	if got := Resolve("mindray_bc5380_sketch", "hl7v2").Profile.HostQueryMessageTypes; !reflect.DeepEqual(got, []string{"ORM^O01"}) {
		t.Errorf("bc5380 sketch changed: %v", got)
	}
}

func TestMetis_ResolveReturnsIndependentCopy(t *testing.T) {
	a := Resolve("getein_metis", "hl7v2").Profile
	a.HostQueryMessageTypes[0] = "EVIL^X01"
	a.ReplyAckPolicy = "none"
	a.ReplyAckMatchControlId = true
	a.ReplyTimeout = time.Hour
	a.HL7AckFullForm = false
	b := Resolve("getein_metis", "hl7v2").Profile
	if b.HostQueryMessageTypes[0] != "QRY^Q02" || b.ReplyAckPolicy != "last" || b.ReplyAckMatchControlId || b.ReplyTimeout != 10*time.Second || !b.HL7AckFullForm {
		t.Fatalf("mutation leaked into the registry: %+v", b)
	}
}

func TestMetis_ResolveConcurrentSafe(t *testing.T) {
	done := make(chan struct{})
	for i := 0; i < 16; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 200; j++ {
				r := Resolve("getein_metis", "hl7v2")
				r.Profile.HostQueryMessageTypes[0] = "x"
				r.Profile.ReplyAckPolicy = "none"
				r.Profile.HL7AckFullForm = false
			}
		}()
	}
	for i := 0; i < 16; i++ {
		<-done
	}
	if p := Resolve("getein_metis", "hl7v2").Profile; p.HostQueryMessageTypes[0] != "QRY^Q02" || p.ReplyAckPolicy != "last" || !p.HL7AckFullForm {
		t.Fatalf("corrupted under concurrency: %+v", p)
	}
}
