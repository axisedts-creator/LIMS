package astm

import (
	"bytes"
	"strings"
)

// Delimiters read from the H record (TRD §5.3; positions UNVERIFIED).
type Delimiters struct{ Field, Repeat, Component, Escape byte }

// Record is one E1394 record; Fields[0] is the leading field (starts with the type char).
type Record struct {
	Type   byte
	Fields []string
}

// Message is a tokenised transfer. Without a valid H record it is empty
// (fail closed).
type Message struct {
	Delims    Delimiters
	HasHeader bool
	Records   []Record
}

const recordTypes = "HPORCQSML"

// Tokenize splits raw on CR (tolerating LF), reads delimiters from the first
// record (must be H, ≥ 5 chars) and splits every known-type record into fields.
func Tokenize(raw []byte) Message {
	var lines [][]byte
	for _, l := range bytes.Split(raw, []byte{'\r'}) {
		if l = bytes.Trim(l, "\n"); len(l) > 0 {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 || lines[0][0] != 'H' || len(lines[0]) < 5 {
		return Message{}
	}
	h := lines[0]
	m := Message{HasHeader: true, Delims: Delimiters{h[1], h[2], h[3], h[4]}}
	sep := string(h[1:2])
	for _, l := range lines {
		if strings.IndexByte(recordTypes, l[0]) < 0 {
			continue
		}
		m.Records = append(m.Records, Record{Type: l[0], Fields: strings.Split(string(l), sep)})
	}
	return m
}
