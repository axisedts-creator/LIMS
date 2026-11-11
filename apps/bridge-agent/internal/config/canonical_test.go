package config

// AG-T11 / API-T08 shared golden vector: Go must emit byte-identical canonical JSON to the TS signer
// (services/api/.../service/signing.ts). Rules: 02-TRD 5.10 (keys by code point, no whitespace, minimal escapes
// `"` `\` and C0 as lower-case \u00xx, safe integers only, null allowed).

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGoldenVector_CanonicalBytesAndSHA256(t *testing.T) {
	want := fixture(t, "canonical.expected.bin")
	got, err := Canonicalize(fixture(t, "canonical.vector.json"))
	if err != nil {
		t.Fatalf("Canonicalize(vector): %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("canonical bytes differ from golden\n got: %q\nwant: %q", got, want)
	}
	sum, err := CanonicalSHA256(fixture(t, "canonical.vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	if exp := strings.TrimSpace(string(fixture(t, "canonical.sha256.txt"))); sum != exp {
		t.Fatalf("CanonicalSHA256 = %s, want %s", sum, exp)
	}
}

// LD-73: the fixtures are self-consistent and the key really is the SHA-256("cfg-test-1") synthetic pair.
func TestGoldenFixtures_KeyPairAndSignatureConsistent(t *testing.T) {
	priv, pub := goldenPriv(t), goldenPub(t)
	seed := sha256.Sum256([]byte("cfg-test-1"))
	if !bytes.Equal(priv.Seed(), seed[:]) {
		t.Fatal("test-key.pkcs8.pem is not the LD-73 key (seed != SHA-256(\"cfg-test-1\"))")
	}
	if !bytes.Equal(priv.Public().(ed25519.PublicKey), pub) {
		t.Fatal("test-key.spki.pem does not match test-key.pkcs8.pem")
	}
	exp := fixture(t, "canonical.expected.bin")
	h := sha256.Sum256(exp)
	if hex.EncodeToString(h[:]) != strings.TrimSpace(string(fixture(t, "canonical.sha256.txt"))) {
		t.Fatal("canonical.sha256.txt does not match canonical.expected.bin")
	}
	sig, err := b64d(strings.TrimSpace(string(fixture(t, "signature.b64url.txt"))))
	if err != nil {
		t.Fatalf("signature.b64url.txt: %v", err)
	}
	if !ed25519.Verify(pub, exp, sig) {
		t.Fatal("signature.b64url.txt does not verify over canonical.expected.bin with the test key")
	}
}

// If the Go copy exists it must be byte-identical (c7-fixture-copy-check mirrors this in CI).
func TestGoFixtureCopy_ByteIdenticalWhenPresent(t *testing.T) {
	goDir := filepath.Join("..", "..", "testdata", "config")
	if _, err := os.Stat(goDir); err != nil {
		t.Skip("testdata/config copy not created yet")
	}
	src := filepath.Join("..", "..", "..", "..", "services", "api", "src", "modules", "instruments", "__tests__", "fixtures", "config")
	for _, n := range []string{"canonical.vector.json", "canonical.expected.bin", "canonical.sha256.txt",
		"signature.b64url.txt", "test-key.pkcs8.pem", "test-key.spki.pem"} {
		a, errA := os.ReadFile(filepath.Join(goDir, n))
		b, errB := os.ReadFile(filepath.Join(src, n))
		if errA != nil || errB != nil || !bytes.Equal(a, b) {
			t.Errorf("%s: Go copy not byte-identical to API fixture", n)
		}
	}
}

func TestCanonicalize_Idempotent(t *testing.T) {
	once, err := Canonicalize(fixture(t, "canonical.vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	twice, err := Canonicalize(once)
	if err != nil || !bytes.Equal(once, twice) {
		t.Fatalf("not idempotent: %q vs %q (%v)", once, twice, err)
	}
}

func TestCanonicalize_Table(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"order+whitespace", " { \"b\" : 1 ,\n\"a\" : [ 2 , 1 ] } ", `{"a":[2,1],"b":1}`},
		{"codepoint order beats UTF-16 order", `{"😀":1,"ｚ":2}`, `{"ｚ":2,"😀":1}`}, // U+FF5A < U+1F600
		{"numeric-looking keys sort as strings", `{"10":1,"2":2}`, `{"10":1,"2":2}`},
		{"empty key first", `{"a":1,"":0}`, `{"":0,"a":1}`},
		{"minus zero", `[-0,0]`, `[0,0]`},
		{"safe int bounds", `[9007199254740991,-9007199254740991]`, `[9007199254740991,-9007199254740991]`},
		{"escape solidus dropped", `"a\/b"`, `"a/b"`},
		{"newline lower-case u00xx", `"\n"`, `"\u000a"`},
		{"tab", `"\t"`, `"\u0009"`},
		{"backspace+formfeed+cr", `"\b\f\r"`, `"\u0008\u000c\u000d"`},
		{"0x1f lower-case hex", `"\u001F"`, `"\u001f"`},
		{"DEL not escaped", `"\u007f"`, "\"\x7f\""},
		{"unicode escape becomes raw", `"\u00e9"`, `"é"`},
		{"surrogate pair becomes raw", `"\ud83d\ude00"`, `"😀"`},
		{"line separator not escaped", `"\u2028"`, "\"\u2028\""},
		{"html chars not escaped", `"<>&"`, `"<>&"`},
		{"quote and backslash", `"q\" b\\"`, `"q\" b\\"`},
		{"null true false", `[null,true,false]`, `[null,true,false]`},
		{"empty containers", `{"o":{},"a":[]}`, `{"a":[],"o":{}}`},
	}
	for _, c := range cases {
		got, err := Canonicalize([]byte(c.in))
		if err != nil {
			t.Errorf("%s: unexpected error %v", c.name, err)
			continue
		}
		if string(got) != c.want {
			t.Errorf("%s:\n got: %q\nwant: %q", c.name, got, c.want)
		}
	}
}

func TestCanonicalize_RejectsWhatItCannotRepresentExactly(t *testing.T) {
	bad := map[string]string{
		"empty":                    ``,
		"truncated":                `{`,
		"trailing garbage":         `{} {}`,
		"missing value":            `{"a":}`,
		"trailing comma array":     `[1,]`,
		"trailing comma object":    `{"a":1,}`,
		"bare word":                `nul`,
		"fractional number":        `1.5`,
		"exponent number":          `1e3`, // fail closed: TS signer never emits it (integers only, 5.10)
		"unsafe integer":           `9007199254740992`,
		"unsafe negative integer":  `-9007199254740992`,
		"lone high surrogate":      `"\ud800"`,
		"lone low surrogate":       `"\udc00"`,
		"invalid UTF-8":            "\"\xff\"",
		"UTF-8 BOM":                "\xef\xbb\xbf{}",
		"duplicate key":            `{"a":1,"a":2}`,
		"nested duplicate key":     `{"x":{"a":1,"a":2}}`,
		"duplicate via escape":     `{"a":1,"\u0061":2}`,
		"raw control char in text": "\"a\x01b\"",
	}
	for name, in := range bad {
		if out, err := Canonicalize([]byte(in)); err == nil {
			t.Errorf("%s: accepted %q -> %q (must fail closed)", name, in, out)
		}
	}
}

func TestCanonicalize_DeepNestingDoesNotPanicOrHang(t *testing.T) {
	deep := strings.Repeat("[", 200000) + strings.Repeat("]", 200000)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				t.Errorf("panic on deep nesting: %v", r)
			}
		}()
		_, _ = Canonicalize([]byte(deep)) // error or success are both fine
	}()
	select {
	case <-done:
	case <-time.After(20 * time.Second):
		t.Fatal("deep nesting hangs")
	}
}
