package drivers

// AG-T09 tests (tester, written first). Contract the implementation must satisfy
// (TRD 5.5, 5.2.4, 6.3; plan row AG-T09 "unknown profile fallback reported"):
//
//	const ProfileUnknownCode = "driver_profile_unknown"       // heartbeat code, TRD 5.5
//	type ASTMTimers struct {                                    // TRD 5.2.4 defaults, per-instrument overridable
//	    EstablishReply, NakRetryDelay, HostContentionDefer, InstrumentContentionRetry,
//	    TransferReply, ReceiverFrameWait, ReceiverInterruptBackoff, OutboundRetryCycle time.Duration
//	    MaxFrameSends, MaxEstablishAttempts, MaxOutboundCycles int
//	    Encoding string
//	}
//	type SessionProfile struct {                                // TRD 5.5 verbatim
//	    Code, Protocol string; ASTMDefaults *ASTMTimers
//	    HL7AckMode, HL7AckMessageTypeFormat string
//	    HostQueryMessageTypes []string; ExpectAckOnReply bool; ReplyTimeout time.Duration
//	}
//	type Resolution struct {
//	    Profile        SessionProfile // never aliases registry state
//	    Known          bool           // driver_code has its own agent profile
//	    HeartbeatError string         // "" when Known; ProfileUnknownCode when not
//	}
//	func Resolve(driverCode, protocol string) Resolution  // never panics, never errors
//	func Codes() []string                                  // registered profile codes, sorted
//
// Unknown driver_code -> generic profile for the protocol ("astm"->astm_generic_e1394,
// "hl7v2"->hl7v2_generic_oru, "file_drop"->file_drop_generic), Known=false, reported.
// Unknown protocol too -> zero Profile, Known=false, still reported.

import (
	"reflect"
	"sort"
	"testing"
	"time"
)

// H80-T01 (LD-139, 08-ADDENDUM-TRUTH-H80E §7) added truth_h80e (five to six); MET-T01 (LD-163, 09-ADDENDUM-GETEIN-METIS §7)
// adds getein_metis: the registered set grows from six to seven.
func TestCodesAreExactlyTheSevenProfiles(t *testing.T) {
	want := []string{
		"astm_generic_e1394", "file_drop_generic", "getein_metis", "hl7v2_generic_oru",
		"mindray_bc5380_sketch", "mindray_bs200_sketch", "truth_h80e",
	}
	got := Codes()
	if !sort.StringsAreSorted(got) {
		t.Fatalf("Codes() must be sorted: %v", got)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Codes() = %v, want %v", got, want)
	}
}

func TestEveryRegisteredCodeResolvesKnownAndSelfConsistent(t *testing.T) {
	protoOf := map[string]string{
		"astm_generic_e1394": "astm", "hl7v2_generic_oru": "hl7v2", "file_drop_generic": "file_drop",
		"mindray_bc5380_sketch": "hl7v2", "mindray_bs200_sketch": "hl7v2", "truth_h80e": "hl7v2", "getein_metis": "hl7v2",
	}
	for _, code := range Codes() {
		r := Resolve(code, protoOf[code])
		if !r.Known || r.HeartbeatError != "" {
			t.Errorf("%s: Known=%v HeartbeatError=%q, want known and silent", code, r.Known, r.HeartbeatError)
		}
		if r.Profile.Code != code {
			t.Errorf("%s: Profile.Code = %q", code, r.Profile.Code)
		}
		if r.Profile.Protocol != protoOf[code] {
			t.Errorf("%s: Profile.Protocol = %q, want %q", code, r.Profile.Protocol, protoOf[code])
		}
	}
}

func TestGenericASTMProfileCarriesTRDDefaults(t *testing.T) {
	p := Resolve("astm_generic_e1394", "astm").Profile
	if p.ASTMDefaults == nil {
		t.Fatal("ASTMDefaults nil")
	}
	a := p.ASTMDefaults
	if a.EstablishReply != 15*time.Second || a.NakRetryDelay != 10*time.Second ||
		a.HostContentionDefer != 20*time.Second || a.InstrumentContentionRetry != time.Second ||
		a.TransferReply != 15*time.Second || a.ReceiverFrameWait != 30*time.Second ||
		a.ReceiverInterruptBackoff != 15*time.Second || a.OutboundRetryCycle != 60*time.Second {
		t.Errorf("timer defaults wrong: %+v", *a)
	}
	if a.MaxFrameSends != 6 || a.MaxEstablishAttempts != 6 || a.MaxOutboundCycles != 3 || a.Encoding != "latin1" {
		t.Errorf("counter/encoding defaults wrong: %+v", *a)
	}
	if len(p.HostQueryMessageTypes) != 0 {
		t.Errorf("astm generic has no HL7 host query types: %v", p.HostQueryMessageTypes)
	}
}

func TestGenericHL7ProfileDefaults(t *testing.T) {
	p := Resolve("hl7v2_generic_oru", "hl7v2").Profile
	if p.HL7AckMode != "auto" || p.HL7AckMessageTypeFormat != "ACK" {
		t.Errorf("ack defaults: mode=%q fmt=%q, want auto / ACK", p.HL7AckMode, p.HL7AckMessageTypeFormat)
	}
	if len(p.HostQueryMessageTypes) != 0 {
		t.Errorf("generic HL7 has no host query (capabilities.hostQuery=false): %v", p.HostQueryMessageTypes)
	}
	if p.ASTMDefaults != nil {
		t.Errorf("HL7 profile must not carry ASTM timers")
	}
}

func TestFileDropProfileHasNoLinkSettings(t *testing.T) {
	p := Resolve("file_drop_generic", "file_drop").Profile
	if p.ASTMDefaults != nil || len(p.HostQueryMessageTypes) != 0 || p.ExpectAckOnReply {
		t.Errorf("file_drop profile must be bare: %+v", p)
	}
}

func TestMindraySketchProfiles(t *testing.T) {
	cases := map[string][]string{
		"mindray_bc5380_sketch": {"ORM^O01"},
		"mindray_bs200_sketch":  {"QRY^Q02"},
	}
	for code, want := range cases {
		r := Resolve(code, "hl7v2")
		if !r.Known {
			t.Errorf("%s must be a known (sketch) profile", code)
		}
		if !reflect.DeepEqual(r.Profile.HostQueryMessageTypes, want) {
			t.Errorf("%s HostQueryMessageTypes = %v, want %v", code, r.Profile.HostQueryMessageTypes, want)
		}
		if r.Profile.ASTMDefaults != nil {
			t.Errorf("%s: no ASTM timers on an HL7 profile", code)
		}
	}
}

func TestUnknownDriverCodeFallsBackToProtocolGenericAndIsReported(t *testing.T) {
	cases := []struct{ proto, wantCode string }{
		{"astm", "astm_generic_e1394"},
		{"hl7v2", "hl7v2_generic_oru"},
		{"file_drop", "file_drop_generic"},
	}
	for _, c := range cases {
		r := Resolve("autobio_a15_vendor", c.proto)
		if r.Known {
			t.Errorf("%s: unknown code reported Known", c.proto)
		}
		if r.HeartbeatError != "driver_profile_unknown" {
			t.Errorf("%s: HeartbeatError = %q, want driver_profile_unknown", c.proto, r.HeartbeatError)
		}
		if ProfileUnknownCode != "driver_profile_unknown" {
			t.Errorf("ProfileUnknownCode = %q", ProfileUnknownCode)
		}
		if r.Profile.Code != c.wantCode {
			t.Errorf("%s: fallback Profile.Code = %q, want %q", c.proto, r.Profile.Code, c.wantCode)
		}
		want := Resolve(c.wantCode, c.proto).Profile
		if !reflect.DeepEqual(r.Profile, want) {
			t.Errorf("%s: fallback profile differs from the generic profile", c.proto)
		}
	}
}

func TestUnknownCodeEdgeInputsNeverPanicAndAreReported(t *testing.T) {
	codes := []string{"", " ", "ASTM_GENERIC_E1394", "astm_generic_e1394 ", "../../etc/passwd",
		"x'; DROP TABLE instruments--", "mindray_bc5380", string(make([]byte, 100000)), "ünï"}
	for _, code := range codes {
		r := Resolve(code, "hl7v2")
		if r.Known || r.HeartbeatError != ProfileUnknownCode {
			t.Errorf("code %.20q: Known=%v err=%q, want unknown+reported", code, r.Known, r.HeartbeatError)
		}
		if r.Profile.Code != "hl7v2_generic_oru" {
			t.Errorf("code %.20q: fallback = %q", code, r.Profile.Code)
		}
	}
}

func TestUnknownProtocolReportedWithEmptyProfile(t *testing.T) {
	for _, proto := range []string{"", "serial", "ASTM", "hl7"} {
		r := Resolve("whatever", proto)
		if r.Known || r.HeartbeatError != ProfileUnknownCode {
			t.Errorf("proto %q: Known=%v err=%q", proto, r.Known, r.HeartbeatError)
		}
		if !reflect.DeepEqual(r.Profile, SessionProfile{}) {
			t.Errorf("proto %q: want zero profile, got %+v", proto, r.Profile)
		}
	}
	// a registered code with unknown protocol is still not trusted blindly: never panics
	_ = Resolve("astm_generic_e1394", "")
}

func TestResolveReturnsIndependentCopies(t *testing.T) {
	a := Resolve("astm_generic_e1394", "astm").Profile
	a.ASTMDefaults.MaxFrameSends = 99
	a.ASTMDefaults.EstablishReply = time.Hour
	if b := Resolve("astm_generic_e1394", "astm").Profile; b.ASTMDefaults.MaxFrameSends != 6 || b.ASTMDefaults.EstablishReply != 15*time.Second {
		t.Fatalf("mutation leaked into registry: %+v", *b.ASTMDefaults)
	}
	m := Resolve("mindray_bc5380_sketch", "hl7v2").Profile
	m.HostQueryMessageTypes[0] = "EVIL^X01"
	if n := Resolve("mindray_bc5380_sketch", "hl7v2").Profile; n.HostQueryMessageTypes[0] != "ORM^O01" {
		t.Fatalf("slice mutation leaked: %v", n.HostQueryMessageTypes)
	}
	// fallback path too
	f := Resolve("nope", "astm").Profile
	f.ASTMDefaults.MaxOutboundCycles = 42
	if g := Resolve("astm_generic_e1394", "astm").Profile; g.ASTMDefaults.MaxOutboundCycles != 3 {
		t.Fatalf("fallback copy aliased registry: %+v", *g.ASTMDefaults)
	}
}

func TestResolveConcurrentSafe(t *testing.T) {
	done := make(chan struct{})
	for i := 0; i < 32; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for j := 0; j < 200; j++ {
				r := Resolve("mindray_bs200_sketch", "hl7v2")
				r.Profile.HostQueryMessageTypes[0] = "x"
				_ = Resolve("unknown", "astm")
			}
		}()
	}
	for i := 0; i < 32; i++ {
		<-done
	}
	if got := Resolve("mindray_bs200_sketch", "hl7v2").Profile.HostQueryMessageTypes; got[0] != "QRY^Q02" {
		t.Fatalf("corrupted under concurrency: %v", got)
	}
}
