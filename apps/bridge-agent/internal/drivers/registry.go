package drivers

import (
	"sort"
	"time"
)

// registry is built once and never mutated; Resolve returns deep copies.
var registry = map[string]SessionProfile{
	"astm_generic_e1394": {
		Code: "astm_generic_e1394", Protocol: "astm",
		ASTMDefaults: &ASTMTimers{ // TRD 5.2.4
			EstablishReply: 15 * time.Second, NakRetryDelay: 10 * time.Second,
			HostContentionDefer: 20 * time.Second, InstrumentContentionRetry: time.Second,
			TransferReply: 15 * time.Second, ReceiverFrameWait: 30 * time.Second,
			ReceiverInterruptBackoff: 15 * time.Second, OutboundRetryCycle: 60 * time.Second,
			MaxFrameSends: 6, MaxEstablishAttempts: 6, MaxOutboundCycles: 3, Encoding: "latin1",
		},
	},
	"hl7v2_generic_oru": {Code: "hl7v2_generic_oru", Protocol: "hl7v2", HL7AckMode: "auto", HL7AckMessageTypeFormat: "ACK"},
	"file_drop_generic": {Code: "file_drop_generic", Protocol: "file_drop"},
	// Sketches: host-query types only; reply timing/ack expectations are UNVERIFIED per model.
	"mindray_bc5380_sketch": {Code: "mindray_bc5380_sketch", Protocol: "hl7v2", HL7AckMode: "auto",
		HL7AckMessageTypeFormat: "ACK", HostQueryMessageTypes: []string{"ORM^O01"}},
	"mindray_bs200_sketch": {Code: "mindray_bs200_sketch", Protocol: "hl7v2", HL7AckMode: "auto",
		HL7AckMessageTypeFormat: "ACK", HostQueryMessageTypes: []string{"QRY^Q02"}},
	// Truth-H80E, 08-ADDENDUM-TRUTH-H80E §7 (LD-139). ReplyAckPolicy last: QCK, DSR at once, then wait for ACK^Q03.
	// U (unverified until a real capture, addendum §9 items 3 and 5): ReplyTimeout, whether the analyser also ACKs the QCK,
	// the ACK^Q03 MSA-2 form. They are defaults, overridable per instrument, not facts.
	"truth_h80e": {Code: "truth_h80e", Protocol: "hl7v2", HL7AckMode: "original",
		HostQueryMessageTypes: []string{"QRY^Q02"}, ExpectAckOnReply: true,
		ReplyAckPolicy: "last", ReplyAckMatchControlId: false, ReplyTimeout: 10 * time.Second},
	// Getein Metis, 09-ADDENDUM-GETEIN-METIS §7 (LD-163; the addendum header says LD-162, LD-163 is binding).
	// U7 (how long the analyser waits for QCK/DSR, whether QCK is acknowledged): ReplyTimeout is a default, overridable per
	// instrument. U3 (ACK sender names LIS/LIMS) stays configurable via the ack_sending_* options, not fixed here.
	// HL7AckFullForm is the one new opt-in field: §7's literal has none, and the §6 ACK differs from H80E's short ACK.
	"getein_metis": {Code: "getein_metis", Protocol: "hl7v2", HL7AckMode: "original",
		HostQueryMessageTypes: []string{"QRY^Q02"}, ExpectAckOnReply: true,
		ReplyAckPolicy: "last", ReplyAckMatchControlId: false, ReplyTimeout: 10 * time.Second, HL7AckFullForm: true},
}

var genericFor = map[string]string{
	"astm": "astm_generic_e1394", "hl7v2": "hl7v2_generic_oru", "file_drop": "file_drop_generic",
}

// Codes returns the registered profile codes, sorted.
func Codes() []string {
	out := make([]string, 0, len(registry))
	for c := range registry {
		out = append(out, c)
	}
	sort.Strings(out)
	return out
}

// Resolve picks the profile for driverCode. A code with no agent profile falls back
// to the protocol's generic profile and is reported via HeartbeatError (TRD 5.5).
// A registered code whose protocol disagrees with the instrument's is treated as unknown.
// Unknown protocol yields a zero Profile. Never panics.
func Resolve(driverCode, protocol string) Resolution {
	if p, ok := registry[driverCode]; ok && p.Protocol == protocol {
		return Resolution{Profile: p.clone(), Known: true}
	}
	if g, ok := genericFor[protocol]; ok {
		return Resolution{Profile: registry[g].clone(), HeartbeatError: ProfileUnknownCode}
	}
	return Resolution{HeartbeatError: ProfileUnknownCode}
}
