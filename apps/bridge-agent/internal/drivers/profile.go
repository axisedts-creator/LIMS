// Package drivers holds per-driver session profiles (TRD 5.5). Profiles only: no I/O.
package drivers

import "time"

// ProfileUnknownCode is the heartbeat code reported when an instrument's
// driver_code has no agent profile (TRD 5.5).
const ProfileUnknownCode = "driver_profile_unknown"

// ASTMTimers are the TRD 5.2.4 link-layer defaults; per-instrument protocol_options override them.
type ASTMTimers struct {
	EstablishReply            time.Duration
	NakRetryDelay             time.Duration
	HostContentionDefer       time.Duration
	InstrumentContentionRetry time.Duration
	TransferReply             time.Duration
	ReceiverFrameWait         time.Duration
	ReceiverInterruptBackoff  time.Duration
	OutboundRetryCycle        time.Duration
	MaxFrameSends             int
	MaxEstablishAttempts      int
	MaxOutboundCycles         int
	Encoding                  string
}

// SessionProfile is TRD 5.5 verbatim.
type SessionProfile struct {
	Code                    string      // equals instruments.g_drivers.code
	Protocol                string      // "astm" | "hl7v2" | "file_drop"
	ASTMDefaults            *ASTMTimers // §5.2.4 defaults
	HL7AckMode              string      // auto | original | enhanced | none
	HL7AckMessageTypeFormat string      // "ACK" | "ACK^{trigger}^ACK"
	HostQueryMessageTypes   []string    // HL7 MSH-9 values classified as host queries
	ExpectAckOnReply        bool
	ReplyTimeout            time.Duration
	// CR-C7-016 (08-ADDENDUM-TRUTH-H80E §7, LD-139). Zero values keep today's behaviour.
	ReplyAckPolicy         string // "" | "each" (an ACK after every reply message) | "last" (after the final one only) | "none"
	ReplyAckMatchControlId bool   // true: the awaited ACK's MSA-2 must equal the MSH-10 of the reply it acknowledges
	// MET-T01 (09-ADDENDUM-GETEIN-METIS §6, LD-163). false = today's two short ACK segments.
	HL7AckFullForm bool // true: ACK built per addendum §6 (MSH-16 echoed, MSH-18 UTF8, MSA text + error code)
}

// Resolution is the outcome of Resolve.
type Resolution struct {
	Profile        SessionProfile // never aliases registry state
	Known          bool           // driver_code has its own agent profile
	HeartbeatError string         // "" when Known; ProfileUnknownCode otherwise
}

func (p SessionProfile) clone() SessionProfile {
	if p.ASTMDefaults != nil {
		a := *p.ASTMDefaults
		p.ASTMDefaults = &a
	}
	if p.HostQueryMessageTypes != nil {
		p.HostQueryMessageTypes = append([]string(nil), p.HostQueryMessageTypes...)
	}
	return p
}
