// Package hl7 parses the MSH segment and builds ACKs for the agent's MLLP receiver (02-TRD §5.4).
package hl7

import (
	"bytes"
	"errors"
	"fmt"
)

// ErrMSHUnparseable is wrapped by every ParseMSH failure (AC-07.4: no ACK, message stored as incomplete).
var ErrMSHUnparseable = errors.New("hl7: MSH unparseable")

// MSH holds the MSH fields the agent uses (TRD §5.4). Comparable on purpose.
type MSH struct {
	FieldSep                                                          byte
	Encoding                                                          string // MSH-2
	SendingApp, SendingFacility, ReceivingApp, ReceivingFacility      string // MSH-3..6
	DateTime, MessageType, ControlID, Version                         string // MSH-7, 9, 10, 12
	AcceptAckType, AppAckType                                         string // MSH-15, 16
}

// ParseMSH reads only the first segment of msg (the bytes between MLLP blocks).
// MSH-10 is mandatory: without it the agent cannot echo a control id.
func ParseMSH(msg []byte) (MSH, error) {
	if len(msg) < 4 || string(msg[:3]) != "MSH" {
		return MSH{}, fmt.Errorf("%w: first segment is not MSH", ErrMSHUnparseable)
	}
	sep := msg[3]
	if sep <= 0x20 || sep >= 0x7f || isAlnum(sep) {
		return MSH{}, fmt.Errorf("%w: bad field separator", ErrMSHUnparseable)
	}
	seg := msg
	if i := bytes.IndexAny(msg, "\r\n"); i >= 0 {
		seg = msg[:i]
	}
	// MSH-16 is the last field used; 17 parts bounds work on hostile input.
	parts := bytes.SplitN(seg, []byte{sep}, 17)
	f := func(n int) string { // MSH-n, n >= 2
		if n-1 < len(parts) {
			return string(parts[n-1])
		}
		return ""
	}
	m := MSH{
		FieldSep: sep, Encoding: f(2),
		SendingApp: f(3), SendingFacility: f(4), ReceivingApp: f(5), ReceivingFacility: f(6),
		DateTime: f(7), MessageType: f(9), ControlID: f(10), Version: f(12),
		AcceptAckType: f(15), AppAckType: f(16),
	}
	if m.ControlID == "" {
		return MSH{}, fmt.Errorf("%w: MSH-10 missing", ErrMSHUnparseable)
	}
	return m, nil
}

func isAlnum(b byte) bool {
	return b >= '0' && b <= '9' || b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z'
}
