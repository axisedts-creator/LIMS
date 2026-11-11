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
