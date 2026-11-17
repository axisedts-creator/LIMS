package hl7

import (
	"strings"
	"time"
)

// AckCode picks MSA-1 (TRD §5.4). mode ∈ auto|original|enhanced|none (""/unknown = auto).
// Enhanced mode = MSH-15 present; MSH-16 alone does not make it enhanced [CONV].
// send=false means no ACK is written (mode none).
func AckCode(m MSH, mode string, committed bool) (code string, send bool) {
	enhanced := m.AcceptAckType != ""
	switch mode {
	case "none":
		return "", false
	case "original":
		enhanced = false
	case "enhanced":
		enhanced = true
	}
	switch {
	case enhanced && committed:
		return "CA", true
	case enhanced:
		return "CR", true
	case committed:
		return "AA", true
	}
	return "AR", true
}

// AckOptions configures BuildACK.
type AckOptions struct {
	SendingApp      string    // default "LIMS"
	SendingFacility string    // caller supplies the agent code
	TypeFormat      string    // "ACK" (default) | "ACK^{trigger}^ACK"
	Now             time.Time // formatted YYYYMMDDHHMMSS in its own location
	ControlID       string    // MSH-10 of the ACK
	// FullForm builds the 09-ADDENDUM-GETEIN-METIS §6 ACK instead (LD-163): ControlID and TypeFormat are ignored.
	FullForm bool
}

// BuildACK returns the two CR-terminated segments of TRD §5.4, without MLLP framing.
// Every value copied from the instrument is stripped of control bytes and '|' so a hostile
// MSH cannot inject segments or MLLP framing bytes into the ACK.
func BuildACK(m MSH, code string, o AckOptions) []byte {
	if o.FullForm {
		return buildFullACK(m, code, o)
	}
	app := o.SendingApp
	if app == "" {
		app = "LIMS"
	}
	typ := o.TypeFormat
	if typ == "" {
		typ = "ACK"
	}
	typ = strings.ReplaceAll(typ, "{trigger}", trigger(m))
	var b strings.Builder
	b.WriteString("MSH|^~\\&|")
	for _, v := range []string{app, o.SendingFacility, m.SendingApp, m.SendingFacility, o.Now.Format("20060102150405"), "", typ, o.ControlID} {
		b.WriteString(clean(v))
		b.WriteByte('|')
	}
	b.WriteString("P|")
	b.WriteString(clean(m.Version))
	b.WriteString("\rMSA|")
	b.WriteString(clean(code))
	b.WriteByte('|')
	b.WriteString(clean(m.ControlID))
	b.WriteByte('\r')
	return []byte(b.String())
}

// buildFullACK is the 09-ADDENDUM-GETEIN-METIS §6 form (LD-163), byte for byte:
//
//	MSH|^~\&|<app>|<facility>|||<time>||ACK^<trigger>|<MSH-10>|P|<MSH-12>||||<MSH-16>||UTF8|||
//	MSA|<code>|<MSH-10>|<text>|||<error code>|
//
// app/facility default LIS/LIMS (U3: configurable, never fixed). MSH-18 is always UTF8. Values copied from the
// instrument go through clean() like the short form.
func buildFullACK(m MSH, code string, o AckOptions) []byte {
	app, fac := o.SendingApp, o.SendingFacility
	if app == "" {
		app = "LIS"
	}
	if fac == "" {
		fac = "LIMS"
	}
	typ := "ACK"
	if t := trigger(m); t != "" {
		typ += "^" + t
	}
	id := clean(m.ControlID)
	text, errCode := "Message accepted", "0"
	if code != "AA" && code != "CA" { // not stored: the manual's internal-error row (207)
		code, text, errCode = "AR", "Application internal error", "207"
	}
	return []byte("MSH|^~\\&|" + clean(app) + "|" + clean(fac) + "|||" + o.Now.Format("20060102150405") + "||" + clean(typ) + "|" + id +
		"|P|" + clean(m.Version) + "||||" + clean(m.AppAckType) + "||UTF8|||\r" +
		"MSA|" + code + "|" + id + "|" + text + "|||" + errCode + "|\r")
}

// trigger returns the second component of MSH-9 (e.g. R01 from ORU^R01), or "".
func trigger(m MSH) string {
	sep := "^"
	if m.Encoding != "" {
		sep = m.Encoding[:1]
	}
	if c := strings.Split(m.MessageType, sep); len(c) > 1 {
		return c[1]
	}
	return ""
}

// clean drops control bytes (incl. CR, LF, 0x0B, 0x1C) and the ACK field separator.
func clean(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '|' {
			return -1
		}
		return r
	}, s)
}
