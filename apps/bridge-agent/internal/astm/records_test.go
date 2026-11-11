// AG-T03 tests: E1394 record tokeniser and agent-side classification (02-TRD §5.3).
package astm_test

import (
	"strings"
	"testing"

	"lims/apps/bridge-agent/internal/astm"
)

const hdr = "H|\\^&|||SIM-ANALYSER^0.1|||||||P|1\r"

func TestTokenizeGoldenMessage(t *testing.T) {
	v := loadVectors(t)
	var raw strings.Builder
	for _, f := range v.Frames[:v.AssembledN] {
		raw.WriteString(f.Text)
	}
	m := astm.Tokenize([]byte(raw.String()))
	if !m.HasHeader {
		t.Fatal("H record present: HasHeader must be true")
	}
	if m.Delims != (astm.Delimiters{Field: '|', Repeat: '\\', Component: '^', Escape: '&'}) {
		t.Errorf("delimiters = %+v", m.Delims)
	}
	types := ""
	for _, r := range m.Records {
		types += string(r.Type)
	}
	if types != "HPORL" {
		t.Fatalf("record types %q, want HPORL", types)
	}
	h := m.Records[0]
	if h.Fields[0] != "H" || h.Fields[1] != "\\^&" || h.Fields[4] != "SIM-ANALYSER^0.1" {
		t.Errorf("H fields: %q", h.Fields)
	}
	r := m.Records[3]
	want := []string{"R", "1", "^^^GLU", "5.4", "mmol/L", "", "N", "", "F"}
	if strings.Join(r.Fields, "\x00") != strings.Join(want, "\x00") {
		t.Errorf("R fields = %q, want %q", r.Fields, want)
	}
	if m.Records[2].Fields[2] != "E2600000042" {
		t.Errorf("O record specimen id: %q", m.Records[2].Fields)
	}
}

func TestTokenizeToleratesLFAfterCRAndEmptyRecords(t *testing.T) {
	m := astm.Tokenize([]byte(hdr[:len(hdr)-1] + "\r\n" + "P|1\r\n\r\nL|1|N\r\n"))
	types := ""
	for _, r := range m.Records {
		types += string(r.Type)
	}
	if types != "HPL" {
		t.Errorf("types %q, want HPL (LF after CR tolerated, blank lines skipped)", types)
	}
	for _, r := range m.Records {
		for _, f := range r.Fields {
			if strings.ContainsAny(f, "\r\n") {
				t.Errorf("field %q retains CR/LF", f)
			}
		}
	}
}

func TestTokenizeLastRecordWithoutTrailingCR(t *testing.T) {
	m := astm.Tokenize([]byte(hdr + "L|1|N"))
	if len(m.Records) != 2 || m.Records[1].Type != 'L' {
		t.Errorf("records = %+v", m.Records)
	}
}

func TestTokenizeUsesDelimitersFromHeader(t *testing.T) {
	m := astm.Tokenize([]byte("H#!~$\rR#1#a~b\r"))
	if m.Delims != (astm.Delimiters{Field: '#', Repeat: '!', Component: '~', Escape: '$'}) {
		t.Fatalf("delimiters = %+v", m.Delims)
	}
	if got := m.Records[1].Fields; len(got) != 3 || got[2] != "a~b" {
		t.Errorf("R fields split on '#': %q", got)
	}
}

func TestTokenizeKnownRecordTypes(t *testing.T) {
	var b strings.Builder
	b.WriteString(hdr)
	for _, c := range "PORCQSML" {
		b.WriteString(string(c) + "|1\r")
	}
	m := astm.Tokenize([]byte(b.String()))
	got := ""
	for _, r := range m.Records {
		got += string(r.Type)
	}
	if got != "HPORCQSML" {
		t.Errorf("types %q", got)
	}
}

func TestTokenizeFailsClosedWithoutHeader(t *testing.T) { // §5.3 UNVERIFIED delimiters -> fail closed
	for name, raw := range map[string]string{
		"empty":          "",
		"only CR":        "\r",
		"no H":           "P|1\rR|1|^^^GLU|5.4\rL|1|N\r",
		"H too short":    "H\rL|1|N\r",
		"binary garbage": "\x00\xff\xfe\x01\x02",
		"lowercase h":    "h|\\^&\rR|1\r",
	} {
		m := astm.Tokenize([]byte(raw))
		if m.HasHeader {
			t.Errorf("%s: HasHeader must be false", name)
		}
		if got := astm.Classify([]byte(raw)); got != astm.ClassOther {
			t.Errorf("%s: Classify = %q, want other", name, got)
		}
	}
}

func TestTokenizeNeverPanicsOnHostileInput(t *testing.T) {
	inputs := []string{
		strings.Repeat("|", 1<<20),
		strings.Repeat("H|\\^&\r", 5000),
		"H|\\^&" + strings.Repeat("|", 100000) + "\r",
		strings.Repeat("\r", 100000),
		"H||||\rR\rQ\r",
		"H|\\^&\r" + strings.Repeat("R|1|x\r", 20000),
	}
	for i, in := range inputs {
		_ = astm.Tokenize([]byte(in))
		_ = astm.Classify([]byte(in))
		_ = i
	}
}

// ---- Classification ----

func TestClassify(t *testing.T) { // §5.3: Q and no R -> host_query; any R -> data; else other
	cases := []struct {
		name string
		raw  string
		want astm.Class
	}{
		{"result session", hdr + "P|1\rO|1|E2600000042||^^^GLU\rR|1|^^^GLU|5.4|mmol/L||N||F\rL|1|N\r", astm.ClassData},
		{"host query only", hdr + "Q|1|^E2600000042||||||||||O\rL|1|N\r", astm.ClassHostQuery},
		{"two queries", hdr + "Q|1|^E1\rQ|2|^E2\rL|1|N\r", astm.ClassHostQuery},
		{"query plus result -> data", hdr + "Q|1|^E1\rR|1|^^^GLU|5.4\rL|1|N\r", astm.ClassData},
		{"result before query -> data", hdr + "R|1|^^^GLU|5.4\rQ|1|^E1\rL|1|N\r", astm.ClassData},
		{"no R no Q -> other", hdr + "P|1\rO|1|E2600000042\rL|1|N\r", astm.ClassOther},
		{"header+terminator only -> other", hdr + "L|1|N\r", astm.ClassOther},
		{"comment record is not a query", hdr + "C|1|I|Q-check\rL|1|N\r", astm.ClassOther},
		{"scientific/manufacturer are not R or Q", hdr + "S|1\rM|1\rL|1|N\r", astm.ClassOther},
	}
	for _, c := range cases {
		if got := astm.Classify([]byte(c.raw)); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestClassifyUsesRecordTypeNotFieldContent(t *testing.T) {
	// 'R' / 'Q' appearing inside fields or as non-leading characters must not count.
	raw := hdr + "P|1|R|Q\rO|1|R2600000042||^^^Q\rC|1|R|Q\rL|1|N\r"
	if got := astm.Classify([]byte(raw)); got != astm.ClassOther {
		t.Errorf("got %q, want other", got)
	}
	// Record type is the FIRST character only; "RQ|..." is an R record, "QR|..." is a Q record.
	if got := astm.Classify([]byte(hdr + "QR|1\rL|1|N\r")); got != astm.ClassHostQuery {
		t.Errorf("QR| record: got %q, want host_query", got)
	}
}

func TestClassifyLowercaseRecordTypesAreNotRecognised(t *testing.T) {
	if got := astm.Classify([]byte(hdr + "r|1|^^^GLU|5.4\rq|1\rL|1|N\r")); got != astm.ClassOther {
		t.Errorf("got %q, want other", got)
	}
}

func TestClassConstantValues(t *testing.T) {
	if astm.ClassData != "data" || astm.ClassHostQuery != "host_query" || astm.ClassOther != "other" {
		t.Errorf("class strings: %q %q %q", astm.ClassData, astm.ClassHostQuery, astm.ClassOther)
	}
}

func TestClassifyAssembledFromFramesEndToEnd(t *testing.T) { // AC-05.3/05.5 glue: frames -> raw -> class
	v := loadVectors(t)
	var frames []astm.Frame
	prev := -1
	for _, f := range v.Frames[:v.AssembledN] {
		exp := 1
		if prev >= 0 {
			exp = astm.NextFN(prev)
		}
		raw, _ := astm.EncodeFrame(f.FN, []byte(f.Text), term(t, f.Terminator))
		fr, verdict := astm.Receive(raw, exp, prev)
		if verdict != astm.Accept {
			t.Fatalf("frame FN %d: %v", f.FN, verdict)
		}
		prev = fr.FN
		frames = append(frames, fr)
	}
	if got := astm.Classify(astm.Assemble(frames)); got != astm.ClassData {
		t.Errorf("golden session classified %q, want data", got)
	}
}
