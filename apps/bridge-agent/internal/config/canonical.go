// Package config verifies and applies the signed agent configuration (02-TRD 5.10, AC-15.1).
package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"unicode/utf8"
)

// Canonical JSON (02-TRD 5.10, must be byte-identical to the TS signer): UTF-8, keys sorted by code point,
// no whitespace, only `"` `\` and C0 controls escaped (C0 as lower-case \u00xx), safe integers only, null allowed.
// Fail closed on anything that cannot be represented exactly (floats, duplicate keys, lone surrogates, BOM).

const (
	maxSafeInt = 1<<53 - 1
	maxDepth   = 64
)

// Canonicalize returns the canonical form of one JSON value.
func Canonicalize(raw []byte) ([]byte, error) {
	p := &parser{b: raw}
	p.ws()
	out, err := p.value(0)
	if err != nil {
		return nil, err
	}
	p.ws()
	if p.i != len(p.b) {
		return nil, p.fail("trailing data")
	}
	return out, nil
}

// CanonicalSHA256 is the lower-case hex SHA-256 of Canonicalize(raw).
func CanonicalSHA256(raw []byte) (string, error) {
	c, err := Canonicalize(raw)
	if err != nil {
		return "", err
	}
	s := sha256.Sum256(c)
	return hex.EncodeToString(s[:]), nil
}

type parser struct {
	b []byte
	i int
}

func (p *parser) fail(msg string) error { return fmt.Errorf("canonical json: %s at byte %d", msg, p.i) }

func (p *parser) ws() {
	for p.i < len(p.b) && (p.b[p.i] == ' ' || p.b[p.i] == '\t' || p.b[p.i] == '\n' || p.b[p.i] == '\r') {
		p.i++
	}
}

func (p *parser) lit(s string, v []byte) ([]byte, error) {
	if !bytes.HasPrefix(p.b[p.i:], []byte(s)) {
		return nil, p.fail("invalid literal")
	}
	p.i += len(s)
	return v, nil
}

func (p *parser) value(depth int) ([]byte, error) {
	if depth > maxDepth {
		return nil, p.fail("nesting too deep")
	}
	if p.i >= len(p.b) {
		return nil, p.fail("unexpected end")
	}
	switch c := p.b[p.i]; {
	case c == '{':
		return p.object(depth)
	case c == '[':
		return p.array(depth)
	case c == '"':
		s, err := p.str()
		if err != nil {
			return nil, err
		}
		return quote(s), nil
	case c == 't':
		return p.lit("true", []byte("true"))
	case c == 'f':
		return p.lit("false", []byte("false"))
	case c == 'n':
		return p.lit("null", []byte("null"))
	case c == '-' || (c >= '0' && c <= '9'):
		return p.number()
	}
	return nil, p.fail("unexpected character")
}

func (p *parser) number() ([]byte, error) {
	start := p.i
	neg := p.b[p.i] == '-'
	if neg {
		p.i++
	}
	ds := p.i
	for p.i < len(p.b) && p.b[p.i] >= '0' && p.b[p.i] <= '9' {
		p.i++
	}
	digits := p.b[ds:p.i]
	if len(digits) == 0 || (len(digits) > 1 && digits[0] == '0') {
		return nil, p.fail("invalid number")
	}
	if p.i < len(p.b) && (p.b[p.i] == '.' || p.b[p.i] == 'e' || p.b[p.i] == 'E') {
		return nil, p.fail("non-integer number")
	}
	if len(digits) > 16 || (len(digits) == 16 && string(digits) > "9007199254740991") {
		return nil, p.fail("integer outside the safe range")
	}
	if string(digits) == "0" {
		return []byte("0"), nil // -0 -> 0
	}
	return append([]byte(nil), p.b[start:p.i]...), nil
}

func (p *parser) hex4() (rune, error) {
	if p.i+4 > len(p.b) {
		return 0, p.fail("bad \\u escape")
	}
	var r rune
	for _, c := range p.b[p.i : p.i+4] {
		switch {
		case c >= '0' && c <= '9':
			r = r<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			r = r<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			r = r<<4 | rune(c-'A'+10)
		default:
			return 0, p.fail("bad \\u escape")
		}
	}
	p.i += 4
	return r, nil
}

// str parses a JSON string at p.i and returns its decoded (valid UTF-8) value.
func (p *parser) str() (string, error) {
	p.i++ // opening quote
	var sb []byte
	for {
		if p.i >= len(p.b) {
			return "", p.fail("unterminated string")
		}
		c := p.b[p.i]
		switch {
		case c == '"':
			p.i++
			return string(sb), nil
		case c < 0x20:
			return "", p.fail("raw control character in string")
		case c == '\\':
			p.i++
			if p.i >= len(p.b) {
				return "", p.fail("unterminated escape")
			}
			e := p.b[p.i]
			p.i++
			switch e {
			case '"', '\\', '/':
				sb = append(sb, e)
			case 'b':
				sb = append(sb, 8)
			case 'f':
				sb = append(sb, 12)
			case 'n':
				sb = append(sb, 10)
			case 'r':
				sb = append(sb, 13)
			case 't':
				sb = append(sb, 9)
			case 'u':
				r, err := p.hex4()
				if err != nil {
					return "", err
				}
				if r >= 0xDC00 && r <= 0xDFFF {
					return "", p.fail("lone low surrogate")
				}
				if r >= 0xD800 && r <= 0xDBFF {
					if p.i+2 > len(p.b) || p.b[p.i] != '\\' || p.b[p.i+1] != 'u' {
						return "", p.fail("lone high surrogate")
					}
					p.i += 2
					lo, err := p.hex4()
					if err != nil {
						return "", err
					}
					if lo < 0xDC00 || lo > 0xDFFF {
						return "", p.fail("lone high surrogate")
					}
					r = 0x10000 + (r-0xD800)<<10 + (lo - 0xDC00)
				}
				sb = utf8.AppendRune(sb, r)
			default:
				return "", p.fail("bad escape")
			}
		default:
			r, n := utf8.DecodeRune(p.b[p.i:])
			if r == utf8.RuneError && n <= 1 {
				return "", p.fail("invalid UTF-8")
			}
			sb = append(sb, p.b[p.i:p.i+n]...)
			p.i += n
		}
	}
}

func quote(s string) []byte {
	const hexd = "0123456789abcdef"
	out := make([]byte, 0, len(s)+2)
	out = append(out, '"')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; {
		case c == '"' || c == '\\':
			out = append(out, '\\', c)
		case c < 0x20:
			out = append(out, '\\', 'u', '0', '0', hexd[c>>4], hexd[c&15])
		default:
			out = append(out, c)
		}
	}
	return append(out, '"')
}

func (p *parser) array(depth int) ([]byte, error) {
	p.i++
	out := []byte{'['}
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == ']' {
		p.i++
		return append(out, ']'), nil
	}
	for first := true; ; first = false {
		if !first {
			out = append(out, ',')
		}
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		out = append(out, v...)
		p.ws()
		if p.i >= len(p.b) {
			return nil, p.fail("unterminated array")
		}
		switch p.b[p.i] {
		case ',':
			p.i++
		case ']':
			p.i++
			return append(out, ']'), nil
		default:
			return nil, p.fail("expected , or ]")
		}
	}
}

type member struct {
	key string
	val []byte
}

func (p *parser) object(depth int) ([]byte, error) {
	p.i++
	var ms []member
	p.ws()
	if p.i < len(p.b) && p.b[p.i] == '}' {
		p.i++
		return []byte("{}"), nil
	}
	for {
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != '"' {
			return nil, p.fail("expected object key")
		}
		k, err := p.str()
		if err != nil {
			return nil, err
		}
		p.ws()
		if p.i >= len(p.b) || p.b[p.i] != ':' {
			return nil, p.fail("expected :")
		}
		p.i++
		p.ws()
		v, err := p.value(depth + 1)
		if err != nil {
			return nil, err
		}
		ms = append(ms, member{k, v})
		p.ws()
		if p.i >= len(p.b) {
			return nil, p.fail("unterminated object")
		}
		if p.b[p.i] == ',' {
			p.i++
			continue
		}
		if p.b[p.i] != '}' {
			return nil, p.fail("expected , or }")
		}
		p.i++
		break
	}
	// UTF-8 byte order == code point order.
	sort.Slice(ms, func(i, j int) bool { return ms[i].key < ms[j].key })
	out := []byte{'{'}
	for i, m := range ms {
		if i > 0 {
			if m.key == ms[i-1].key {
				return nil, errors.New("canonical json: duplicate object key")
			}
			out = append(out, ',')
		}
		out = append(out, quote(m.key)...)
		out = append(out, ':')
		out = append(out, m.val...)
	}
	return append(out, '}'), nil
}
