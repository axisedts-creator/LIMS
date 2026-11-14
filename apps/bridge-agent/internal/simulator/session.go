// Package simulator runs the synthetic instrument sessions of 02-TRD §15.3 against the agent's real link layers
// (astm, mllp, filedrop, hostquery) over an in-memory duplex, a fake clock and a real queue (AC-21.1).
// Session files are data, never code: strict JSON, bounded size, no path is ever derived from their content.
package simulator

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	maxSessionFile = 1 << 20
	maxSteps       = 10000
	maxWaitMs      = 24 * 3600 * 1000
)

// Session is one *.session.json (02-TRD §15.3).
type Session struct {
	Name              string         `json:"name"`
	Protocol          string         `json:"protocol"` // astm | hl7v2 | file_drop
	Transport         string         `json:"transport"`
	InstrumentProfile string         `json:"instrument_profile"`
	Options           map[string]any `json:"options"`
	Steps             []Step         `json:"steps"`
}

// Step has exactly one action: From, Expect, WaitMs, ExpectQueue, Outbound, HostQuery or File. Note is free text.
type Step struct {
	From        string       `json:"from"`   // "instrument": feed Bytes to the agent
	Expect      string       `json:"expect"` // "agent": the bytes the agent wrote since the last expect must equal Bytes exactly
	Bytes       *string      `json:"bytes"`  // mnemonics, see ParseBytes; "{now}" in an expect = fake clock as YYYYMMDDHHMMSS
	WithinMs    int          `json:"within_ms"`
	WaitMs      *int         `json:"wait_ms"`      // advance the fake clock, then tick the link layer (file_drop: one scan)
	ExpectQueue *QueueExpect `json:"expect_queue"` // assert the queue
	Outbound    []string     `json:"outbound"`     // astm: submit one outbound message (records, mnemonics) to the sender
	HostQuery   *HostQuery   `json:"host_query"`   // astm: relay the newest host_query item to a server stub that answers Reply; hl7v2: set the stub's answer
	File        *FileOp      `json:"file"`         // file_drop: write or append a file in the watched folder
	Note        string       `json:"note"`
}

// QueueExpect: Items is the item count; Kind applies to every item; RawSHA256 must equal the hash of the only item,
// or, with several items, of at least one of them.
type QueueExpect struct {
	Items     *int   `json:"items"`
	Kind      string `json:"kind"`
	RawSHA256 string `json:"raw_sha256"`
	Note      string `json:"note"`
}

type HostQuery struct {
	Reply []string `json:"reply"` // exactly one reply message (mnemonics)
}

type FileOp struct {
	Write  string `json:"write"`
	Append string `json:"append"`
	Text   string `json:"text"`
}

var (
	mnemonics = map[string]byte{"ENQ": 0x05, "ACK": 0x06, "NAK": 0x15, "EOT": 0x04, "STX": 0x02, "ETX": 0x03,
		"ETB": 0x17, "CR": 0x0D, "LF": 0x0A, "VT": 0x0B, "FS": 0x1C}
	mnemonicRe = regexp.MustCompile(`^<([A-Z]{1,8})>`)
	fileNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)
)

// ParseBytes turns a session "bytes" string into bytes. <ENQ> <ACK> <NAK> <EOT> <STX> <ETX> <ETB> <CR> <LF> <VT> <FS>
// are control bytes; any other <UPPERCASE> token is an error; everything else (incl. a lone '<') is literal.
func ParseBytes(s string) ([]byte, error) {
	var out []byte
	for i := 0; i < len(s); {
		if s[i] == '<' {
			if m := mnemonicRe.FindStringSubmatch(s[i:]); m != nil {
				b, ok := mnemonics[m[1]]
				if !ok {
					return nil, fmt.Errorf("unknown mnemonic <%s>", m[1])
				}
				out = append(out, b)
				i += len(m[0])
				continue
			}
		}
		out = append(out, s[i])
		i++
	}
	return out, nil
}

// show renders bytes back as mnemonics, for error messages.
func show(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		done := false
		for n, v := range mnemonics {
			if v == c {
				sb.WriteString("<" + n + ">")
				done = true
				break
			}
		}
		if !done {
			if c < 0x20 || c > 0x7e {
				fmt.Fprintf(&sb, "\\x%02x", c)
			} else {
				sb.WriteByte(c)
			}
		}
	}
	return "\"" + sb.String() + "\""
}

// LoadSession reads and validates one session file. Malformed or unknown shapes are errors.
func LoadSession(path string) (Session, error) {
	f, err := os.Open(path)
	if err != nil {
		return Session{}, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, maxSessionFile+1))
	if err != nil {
		return Session{}, err
	}
	if len(b) > maxSessionFile {
		return Session{}, errors.New("session file larger than 1 MiB")
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var s Session
	if err := dec.Decode(&s); err != nil {
		return Session{}, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return Session{}, fmt.Errorf("%s: trailing data after the session object", filepath.Base(path))
	}
	if err := s.validate(); err != nil {
		return Session{}, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	return s, nil
}

// LoadDir loads every *.session.json of dir, sorted by file name. A dir without sessions is an error.
func LoadDir(dir string) ([]Session, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".session.json") {
			names = append(names, e.Name())
		}
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("no *.session.json in %s", dir)
	}
	sort.Strings(names)
	out := make([]Session, 0, len(names))
	for _, n := range names {
		s, err := LoadSession(filepath.Join(dir, n))
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

func (s Session) validate() error {
	if s.Name == "" || len(s.Name) > 200 {
		return errors.New("name is required (1-200 chars)")
	}
	switch s.Protocol {
	case "astm", "hl7v2", "file_drop":
	default:
		return fmt.Errorf("unknown protocol %q", s.Protocol)
	}
	if s.Transport == "" {
		return errors.New("transport is required")
	}
	if len(s.Steps) == 0 || len(s.Steps) > maxSteps {
		return fmt.Errorf("steps: need 1..%d", maxSteps)
	}
	for i, st := range s.Steps {
		if err := st.validate(s.Protocol); err != nil {
			return fmt.Errorf("step %d: %w", i+1, err)
		}
	}
	return nil
}

func (st Step) validate(protocol string) error {
	kinds := 0
	for _, set := range []bool{st.From != "", st.Expect != "", st.WaitMs != nil, st.ExpectQueue != nil,
		st.Outbound != nil, st.HostQuery != nil, st.File != nil} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		return fmt.Errorf("a step needs exactly one of from/expect/wait_ms/expect_queue/outbound/host_query/file, has %d", kinds)
	}
	switch {
	case st.From != "" || st.Expect != "":
		if (st.From != "" && st.From != "instrument") || (st.Expect != "" && st.Expect != "agent") {
			return errors.New(`"from" must be "instrument" and "expect" must be "agent"`)
		}
		if st.Bytes == nil {
			return errors.New("bytes is required")
		}
		if protocol == "file_drop" {
			return errors.New("file_drop sessions have no byte stream")
		}
		if _, err := ParseBytes(strings.ReplaceAll(*st.Bytes, "{now}", "")); err != nil {
			return err
		}
	case st.WaitMs != nil:
		if *st.WaitMs < 0 || *st.WaitMs > maxWaitMs {
			return errors.New("wait_ms out of range")
		}
	case st.ExpectQueue != nil:
		if st.ExpectQueue.Items == nil || *st.ExpectQueue.Items < 0 {
			return errors.New("expect_queue.items is required")
		}
	case st.Outbound != nil:
		if protocol != "astm" || len(st.Outbound) == 0 {
			return errors.New("outbound needs an astm session and at least one record")
		}
		for _, r := range st.Outbound {
			if _, err := ParseBytes(r); err != nil {
				return err
			}
		}
	case st.HostQuery != nil:
		// astm: relay the newest host_query item, exactly one reply. hl7v2: configure the server stub for the
		// instrument's next query; 0 replies = API unreachable, the agent must write nothing (AC-10.6).
		if !(protocol == "astm" && len(st.HostQuery.Reply) == 1) && !(protocol == "hl7v2" && len(st.HostQuery.Reply) <= 8) {
			return errors.New("host_query needs an astm session with exactly one reply message, or an hl7v2 session with at most 8")
		}
		for _, r := range st.HostQuery.Reply {
			if _, err := ParseBytes(r); err != nil {
				return err
			}
		}
	case st.File != nil:
		f := st.File
		name := f.Write + f.Append
		if protocol != "file_drop" || (f.Write == "") == (f.Append == "") || !fileNameRe.MatchString(name) || strings.Contains(name, "..") {
			return errors.New("file needs a file_drop session and one plain file name in write or append")
		}
	}
	return nil
}
