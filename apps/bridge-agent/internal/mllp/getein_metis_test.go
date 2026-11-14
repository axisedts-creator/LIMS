// MET-T01 tests (tester, written first): the Getein Metis ACK form and host-query exchange in the MLLP session.
// Spec: 09-ADDENDUM-GETEIN-METIS §2, §5-§7; PRD AC-10.6; 02-TRD D-02. Binding lead decision LD-163
// (the addendum header calls it LD-162; LD-163 is the binding number).
// Run: go test ./internal/mllp/ -run Metis
//
// Contract expected from the implementation (all opt-in; zero values keep today's behaviour, so H80E and every
// other profile are untouched). Reuses the helpers of replyack_h80e_test.go (same package): start, peer, hq, settle.
//
//	hl7.AckOptions.FullForm bool   // 09-ADDENDUM §6 form instead of the two short segments of TRD §5.4
//	mllp.Config.AckFullForm bool   // set from drivers.SessionProfile.HL7AckFullForm
//
// FullForm ACK, byte for byte (addendum §6; <id> = MSH-10 of the message being answered; one trailing "|" per segment):
//
//	MSH|^~\&|<AckSendingApp>|<AckSendingFacility>|||<time>||ACK^<trigger>|<id>|P|<MSH-12>||||<MSH-16>||UTF8|||<CR>
//	MSA|AA|<id>|Message accepted|||0|<CR>            (not committed: MSA|AR|<id>|Application internal error|||207|)
//
// AckSendingApp / AckSendingFacility empty -> "LIS" / "LIMS" (addendum §6; U3: they stay configurable, never fixed).
// MSH-18 is always UTF8, whatever the instrument sent (UTF8, UTF-8 or blank). Values copied from the instrument are
// stripped of control bytes and "|" exactly as BuildACK does today.
package mllp_test

import (
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/hl7"
	"lims/apps/bridge-agent/internal/mllp"
)

// Synthetic messages built to 09-ADDENDUM §3-§5 (Test Patient / MT2600000042; invented values, short MSH-7 is irrelevant here).
const (
	metORU   = "MSH|^~\\&|GP|Metis|||20261114093015||ORU^R01|57|P|2.3.1||||0||UTF8|||\rPID|1|V000123|||Test Patient||19880912000000|F\rOBR|1|MT2600000042|7|^|N|20261114085510|20261114092940|||||||20261114085730|serum\rOBX|1|NM|0|ALT|31.2|U/L|0-40|N|||F||31.2|20261114093001|||0\r"
	metQC    = "MSH|^~\\&|GP|Metis|||20261114101502||ORU^R01|58|P|2.3.1||||2||UTF8|||\rOBR|1|7|AST|^|||20261114101455||||2|1^2|QCSYN1^QCSYN2|LOT111^LOT222|20300101^20300101||L^H|45.0^120.0|4.5^9.0|44.1^123.4|U/L\r"
	metCal   = "MSH|^~\\&|GP|Metis|||20261114102000||ORU^R01|59|P|2.3.1||||1||UTF8|||\rOBR|1|MT2600000043|8\rOBX|1|NM|0|ALT|1.0|U/L\r"
	metQry   = "MSH|^~\\&|||||20261114104700||QRY^Q02|61|P|2.3.1||||||UTF8|||\rQRD|20261114104700|R|D|9|||RD|MT2600000042|OTH|||T|\rQRF||||||RCT|COR|ALL||\r"
	metQck   = "MSH|^~\\&|||||20261114104701||QCK^Q02|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\rQAK|SR|OK|\r"
	metQckNF = "MSH|^~\\&|||||20261114104701||QCK^Q02|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\rQAK|SR|NF|\r"
	metDsr   = "MSH|^~\\&|||||20261114104701||DSR^Q03|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\rQAK|SR|OK|\rQRD|20261114104700|R|D|9|||RD||OTH|||T|\rQRF||||||RCT|COR|ALL||\rDSP|1||V000123|||\rDSP|21||MT2600000042|||\rDSP|24||N|||\rDSP|26||serum|||\rDSP|29||0^^^|||\rDSC||\r"
	// the manual's ACK^Q03 carries its own id; MSA-2 does NOT have to equal the DSR id (addendum §6)
	metAckQ03   = "MSH|^~\\&|||||20261114104702||ACK^Q03|99|P|2.3.1||||||UTF8|||\rMSA|AA|99|Message accepted|||0|\rERR|0|\r"
	metAckQ03OK = "MSH|^~\\&|||||20261114104702||ACK^Q03|100|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\r"
)

// metAck is the expected FullForm ACK for MSH-10 id, version, MSH-16 value, with the default sender names.
func metAck(typ, id, ver, m16, code, text, errCode string) string {
	return "MSH|^~\\&|LIS|LIMS|||20261105103542||" + typ + "|" + id + "|P|" + ver + "||||" + m16 + "||UTF8|||\r" +
		"MSA|" + code + "|" + id + "|" + text + "|||" + errCode + "|\r"
}

func metCfg(f mllp.HostQueryFunc) mllp.Config {
	return mllp.Config{
		AckMode: "original", AckFullForm: true,
		HostQueryTypes: []string{"QRY^Q02"}, HostQuery: f,
		ExpectAckOnReply: true, ReplyAckPolicy: "last", ReplyAckMatchControlId: false, ReplyTimeout: 10 * time.Second,
	}
}

func metAlive(p *peer) {
	p.t.Helper()
	p.send(metORU)
	if got, want := p.mustNext("AA for the ORU"), metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
		p.t.Fatalf("ORU answer = %q, want %q", got, want)
	}
}

// done criterion: the ACK to an ORU echoes MSH-10, MSH-12 and MSH-16 of the original and carries MSH-18 UTF8.
func TestMetis_OruAckEchoesMsh10Msh12Msh16AndCarriesMsh18(t *testing.T) {
	p := start(t, metCfg(nil))
	p.send(metORU)
	got := p.mustNext("the ACK")
	if want := metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
		t.Fatalf("ACK = %q\nwant  %q", got, want)
	}
	// the same facts, field by field, so a failure names the field
	f := strings.Split(strings.SplitN(got, "\r", 2)[0], "|")
	for n, w := range map[int]string{9: "ACK^R01", 10: "57", 12: "2.3.1", 16: "0", 18: "UTF8"} {
		if f[n-1] != w { // MSH-1 is the separator itself, so MSH-n sits at index n-1 after the split
			t.Errorf("MSH-%d = %q, want %q", n, f[n-1], w)
		}
	}
	if c := p.sink.committed(); len(c) != 1 || c[0] != metORU {
		t.Fatalf("committed = %q, want the ORU committed once before the AA (D-02)", c)
	}
}

// MSH-16 classifies the ORU (0 patient, 1 calibration, 2 QC); the agent echoes whatever it was and judges nothing.
func TestMetis_AckEchoesMsh16ForPatientQcCalibrationAndBlank(t *testing.T) {
	for _, tc := range []struct{ name, msg, id, m16 string }{
		{"patient", metORU, "57", "0"},
		{"qc", metQC, "58", "2"},
		{"calibration", metCal, "59", "1"},
		{"blank", strings.Replace(metORU, "2.3.1||||0||UTF8", "2.3.1||||||UTF8", 1), "57", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := start(t, metCfg(nil))
			p.send(tc.msg)
			if got, want := p.mustNext("ACK"), metAck("ACK^R01", tc.id, "2.3.1", tc.m16, "AA", "Message accepted", "0"); got != want {
				t.Fatalf("ACK = %q\nwant  %q", got, want)
			}
			if c := p.sink.committed(); len(c) != 1 || c[0] != tc.msg {
				t.Fatalf("committed = %q, want the message archived once (calibration too: D-MET-2 archives, never drops)", c)
			}
		})
	}
}

// HL7AckMode original: MSH-12 is the ORIGINAL's version, not a hard-coded 2.3.1 (addendum §3, MSH-12 row).
func TestMetis_AckEchoesTheOriginalsVersion(t *testing.T) {
	p := start(t, metCfg(nil))
	p.send(strings.Replace(metORU, "|P|2.3.1|", "|P|2.3|", 1))
	if got, want := p.mustNext("ACK"), metAck("ACK^R01", "57", "2.3", "0", "AA", "Message accepted", "0"); got != want {
		t.Fatalf("ACK = %q\nwant  %q", got, want)
	}
}

// MSH-18 is UTF8 in the ACK whatever the analyser wrote (the manual writes UTF8; UTF-8 is accepted on input only).
func TestMetis_AckMsh18IsAlwaysUTF8(t *testing.T) {
	for name, in := range map[string]string{
		"UTF-8": strings.Replace(metORU, "||UTF8|||", "||UTF-8|||", 1),
		"blank": strings.Replace(metORU, "||UTF8|||", "||||", 1),
	} {
		t.Run(name, func(t *testing.T) {
			p := start(t, metCfg(nil))
			p.send(in)
			if got, want := p.mustNext("ACK"), metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
				t.Fatalf("ACK = %q\nwant  %q", got, want)
			}
		})
	}
}

// U3: the sender names are configurable defaults, never fixed values.
func TestMetis_AckSenderNamesAreConfigurable(t *testing.T) {
	cfg := metCfg(nil)
	cfg.AckSendingApp, cfg.AckSendingFacility = "LABLIS", "LABSITE"
	p := start(t, cfg)
	p.send(metORU)
	want := strings.Replace(metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"), "|LIS|LIMS|", "|LABLIS|LABSITE|", 1)
	if got := p.mustNext("ACK"); got != want {
		t.Fatalf("ACK = %q\nwant  %q", got, want)
	}
}

// D-02: a failed durable commit is AR with the manual's internal-error text and code 207, same MSH.
func TestMetis_CommitFailureIsAR207(t *testing.T) {
	p := start(t, metCfg(nil))
	p.sink.mu.Lock()
	p.sink.failNext = true
	p.sink.mu.Unlock()
	p.send(metORU)
	if got, want := p.mustNext("AR"), metAck("ACK^R01", "57", "2.3.1", "0", "AR", "Application internal error", "207"); got != want {
		t.Fatalf("ACK = %q\nwant  %q", got, want)
	}
}

// Hostile input: nothing copied from the instrument may add a segment, a field or a framing byte to the ACK.
func TestMetis_AckStripsControlBytesFromEchoedValues(t *testing.T) {
	p := start(t, metCfg(nil))
	p.send(strings.Replace(strings.Replace(metORU, "|57|", "|5\x017|", 1), "||||0||UTF8", "||||0\x1d\x7f||UTF8", 1))
	got := p.mustNext("ACK")
	if want := metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
		t.Fatalf("ACK = %q\nwant  %q (control bytes stripped, nothing injected)", got, want)
	}
	if strings.Count(got, "\r") != 2 {
		t.Fatalf("ACK has %d segments, want exactly MSH + MSA", strings.Count(got, "\r"))
	}
}

// An MSH-9 with no trigger event must not produce a dangling "ACK^".
func TestMetis_AckTypeWithoutTriggerIsPlainACK(t *testing.T) {
	p := start(t, metCfg(nil))
	p.send(strings.Replace(metORU, "ORU^R01", "ORU", 1))
	if got, want := p.mustNext("ACK"), metAck("ACK", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
		t.Fatalf("ACK = %q\nwant  %q", got, want)
	}
}

// "no existing profile or test changes behaviour": without AckFullForm the very same ORU gets today's two short segments.
func TestMetis_WithoutFullFormTheAckIsTodaysShortForm(t *testing.T) {
	cfg := metCfg(nil)
	cfg.AckFullForm = false
	p := start(t, cfg)
	p.send(metORU)
	want := "MSH|^~\\&|LIMS||GP|Metis|20261105103542||ACK|ACKID|P|2.3.1\rMSA|AA|57\r"
	if got := p.mustNext("ACK"); got != want {
		t.Fatalf("ACK = %q\nwant today's %q", got, want)
	}
}

// U8: MSH-10 may restart at 1 after an instrument restart; the agent never de-duplicates on MSH-10 (the server keys on
// MSH-10 + MSH-7 + OBR-2). Both messages are archived and both are acknowledged.
func TestMetis_ReusedMsh10IsCommittedAndAcknowledgedTwice(t *testing.T) {
	p := start(t, metCfg(nil))
	second := strings.Replace(metORU, "20261114093015", "20261114111111", 1)
	p.send(metORU)
	p.mustNext("first ACK")
	p.send(second)
	if got, want := p.mustNext("second ACK"), metAck("ACK^R01", "57", "2.3.1", "0", "AA", "Message accepted", "0"); got != want {
		t.Fatalf("second ACK = %q, want %q", got, want)
	}
	if n := len(p.sink.committed()); n != 2 {
		t.Fatalf("committed %d messages, want 2 (the agent is not the de-duplicator)", n)
	}
}

// done criterion: with ReplyAckPolicy last the QCK is written, the DSR is written immediately, then the agent waits for
// ACK^Q03 and accepts one whose MSA-2 differs. The query itself gets no HL7 ACK (the QCK/DSR are the answer).
func TestMetis_Last_QckThenDsrThenAcceptsAckQ03WithAnotherId(t *testing.T) {
	f, calls, mu := hq(metQck, metDsr)
	p := start(t, metCfg(f))
	p.send(metQry)
	if got := p.mustNext("QCK"); got != metQck {
		t.Fatalf("first reply = %q, want the QCK bytes", got)
	}
	if got := p.mustNext("DSR immediately after the QCK (no ACK between them)"); got != metDsr {
		t.Fatalf("second reply = %q, want the DSR bytes", got)
	}
	p.mustSilent("after the DSR the agent only waits")
	p.send(metAckQ03) // MSA-2 = 99, the DSR was 61
	p.mustSilent("an ACK is never ACKed")
	if n := p.stats.ReplyAckMismatches(); n != 0 {
		t.Errorf("mismatches = %d, want 0 with ReplyAckMatchControlId=false (a differing MSA-2 is accepted)", n)
	}
	if n := p.stats.ReplyAckTimeouts(); n != 0 {
		t.Errorf("timeouts = %d, want 0", n)
	}
	if c := p.sink.committed(); len(c) != 1 || c[0] != metQry {
		t.Fatalf("committed = %q, want only the QRY: the ACK^Q03 is protocol, not data", c)
	}
	mu.Lock()
	if len(*calls) != 1 || (*calls)[0].raw != metQry || (*calls)[0].msh.MessageType != "QRY^Q02" || (*calls)[0].msh.ControlID != "61" {
		t.Fatalf("HostQuery calls = %+v, want one call with the exact QRY bytes", *calls)
	}
	mu.Unlock()
	metAlive(p) // the session is no longer waiting
}

func TestMetis_Last_AckQ03WithTheDsrIdIsAlsoAccepted(t *testing.T) {
	f, _, _ := hq(metQck, metDsr)
	p := start(t, metCfg(f))
	p.send(metQry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	p.send(metAckQ03OK)
	p.mustSilent("ACK consumed")
	if n := p.stats.ReplyAckMismatches(); n != 0 {
		t.Errorf("mismatches = %d, want 0", n)
	}
	metAlive(p)
}

// QRY^Q02 is a host query whatever MSH-16 holds (blank in the manual's example, filled on some units; addendum §2).
func TestMetis_QryIsAHostQueryWithBlankOrFilledMsh16(t *testing.T) {
	for name, q := range map[string]string{
		"blank":  metQry,
		"zero":   strings.Replace(metQry, "2.3.1||||||UTF8", "2.3.1||||0||UTF8", 1),
		"sample": strings.Replace(strings.Replace(metQry, "RD|MT2600000042|OTH", "RD||OTH", 1), "QRF||||||RCT", "QRF||||5|5|RCT", 1),
	} {
		t.Run(name, func(t *testing.T) {
			f, calls, mu := hq(metQckNF)
			p := start(t, metCfg(f))
			p.send(q)
			if got := p.mustNext("QCK NF"); got != metQckNF || !strings.Contains(got, "QAK|SR|NF|") {
				t.Fatalf("reply = %q, want the QCK NF", got)
			}
			p.mustSilent("no DSR after NF (modes b and c are answered NF by the server, addendum §5)")
			mu.Lock()
			defer mu.Unlock()
			if len(*calls) != 1 || (*calls)[0].raw != q {
				t.Fatalf("HostQuery calls = %d, want exactly one with the exact bytes", len(*calls))
			}
		})
	}
}

// PRD AC-10.6 (addendum §7): API unreachable -> no reply at all, the query stays committed, results keep flowing.
func TestMetis_ApiDown_NoReplyAtAll(t *testing.T) {
	p := start(t, metCfg(func([]byte, hl7.MSH) [][]byte { return nil }))
	p.send(metQry)
	p.mustSilent("API down: no QCK, no ACK, no error reply")
	if c := p.sink.committed(); len(c) != 1 || c[0] != metQry {
		t.Fatalf("committed = %q, want the QRY kept (it stays pending, AC-10.6)", c)
	}
	metAlive(p) // an ORU still gets its AA in the Metis form while the query path is down
	p.send(metQry)
	p.mustSilent("still down")
}

func TestMetis_ApiDown_EmptyNonNilReplyListIsAlsoSilent(t *testing.T) {
	p := start(t, metCfg(func([]byte, hl7.MSH) [][]byte { return [][]byte{} }))
	p.send(metQry)
	p.mustSilent("empty reply list")
	metAlive(p)
}

// D-02 for a query: no durable commit -> HostQuery is not called and nothing is written (the analyser times out).
func TestMetis_CommitFailure_QueryIsNotAnswered(t *testing.T) {
	f, calls, mu := hq(metQck, metDsr)
	p := start(t, metCfg(f))
	p.sink.mu.Lock()
	p.sink.failNext = true
	p.sink.mu.Unlock()
	p.send(metQry)
	p.mustSilent("commit failed")
	mu.Lock()
	defer mu.Unlock()
	if len(*calls) != 0 {
		t.Fatalf("HostQuery called %d times after a failed commit", len(*calls))
	}
}

// U7: how long the analyser waits, and so how long we wait for ACK^Q03, is a configurable default; a timeout ends the wait, not the session.
func TestMetis_ReplyTimeoutIsConfigurableAndTheSessionSurvivesIt(t *testing.T) {
	f, _, _ := hq(metQck, metDsr)
	cfg := metCfg(f)
	cfg.ReplyTimeout = 120 * time.Millisecond
	p := start(t, cfg)
	p.send(metQry)
	p.mustNext("QCK")
	p.mustNext("DSR")
	deadline := time.Now().Add(3 * time.Second)
	for p.stats.ReplyAckTimeouts() == 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := p.stats.ReplyAckTimeouts(); n != 1 {
		t.Fatalf("timeouts = %d, want 1 after ReplyTimeout with no ACK^Q03", n)
	}
	metAlive(p)
}

// Many analysers at once: no shared ACK state, each session echoes its own MSH-16 and waits on its own.
func TestMetis_ConcurrentSessionsKeepTheirOwnEchoAndWaitState(t *testing.T) {
	for i, m16 := range []string{"0", "1", "2", "0", "1", "2", "0", "2"} {
		m16 := m16
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			t.Parallel()
			f, _, _ := hq(metQck, metDsr)
			p := start(t, metCfg(f))
			msg := strings.Replace(metORU, "||||0||UTF8", "||||"+m16+"||UTF8", 1)
			p.send(msg)
			if got, want := p.mustNext("ACK"), metAck("ACK^R01", "57", "2.3.1", m16, "AA", "Message accepted", "0"); got != want {
				t.Fatalf("ACK = %q, want %q", got, want)
			}
			p.send(metQry)
			p.mustNext("QCK")
			p.mustNext("DSR")
			p.send(metAckQ03)
			p.mustSilent("ACK consumed")
		})
	}
}
