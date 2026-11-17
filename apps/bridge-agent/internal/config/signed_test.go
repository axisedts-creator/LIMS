package config

// AG-T11 Verify: alg, key_id in trusted list (current+next), Ed25519 signature over canonical(document),
// agent_id == own id, schema valid (02-TRD 5.10; AC-15.1; 07-SECURITY S-09, AB6).
// Check order is fail-closed: nothing in the document is trusted (not even agent_id) until the signature verifies.

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestVerify_GoldenEnvelopeAccepted(t *testing.T) {
	d, err := Verify(goldenEnvelope(t), trusted(t), testAgentID)
	if err != nil {
		t.Fatalf("golden envelope rejected: %v", err)
	}
	if d.ConfigVersion != 7 || d.AgentID != testAgentID || d.KeyID != testKeyID {
		t.Fatalf("decoded wrong: %+v", d)
	}
	if exp := strings.TrimSpace(string(fixture(t, "canonical.sha256.txt"))); d.CanonicalSHA256 != exp {
		t.Fatalf("CanonicalSHA256 = %s, want %s", d.CanonicalSHA256, exp)
	}
}

func TestVerify_SignedHandBuiltDocAccepted_WhitespaceInTransitIsIrrelevant(t *testing.T) {
	priv := goldenPriv(t)
	canon := docJSON(testAgentID, 3, "SIM-CHEM-1")
	var v map[string]any
	if err := json.Unmarshal([]byte(canon), &v); err != nil {
		t.Fatal(err)
	}
	pretty, _ := json.MarshalIndent(v, "", "    ") // reordered/indented on the wire; signature covers canonical form
	env := envelopeRaw("Ed25519", testKeyID, b64(signedSig(priv, canon)), string(pretty))
	if _, err := Verify(env, trusted(t), testAgentID); err != nil {
		t.Fatalf("re-indented document must still verify: %v", err)
	}
}

func TestVerify_BadSignature(t *testing.T) {
	priv := goldenPriv(t)
	canon := docJSON(testAgentID, 8, "SIM-CHEM-1")
	good := signed(priv, testKeyID, canon)
	sig := b64(signedSig(priv, canon))
	first := "A"
	if sig[0] == 'A' {
		first = "B"
	}
	flipFirst := first + sig[1:]

	_, attackerPriv := newKey(t, "attacker")

	cases := map[string][]byte{
		"tampered document value (bit flip)": []byte(strings.Replace(string(good), "SIM-CHEM-1", "SIM-CHEM-2", 1)),
		"tampered version (downgrade->up)":   []byte(strings.Replace(string(good), `"config_version":8`, `"config_version":9`, 1)),
		"tampered signature char":            envelopeRaw("Ed25519", testKeyID, flipFirst, canon),
		"truncated signature":                envelopeRaw("Ed25519", testKeyID, sig[:len(sig)-4], canon),
		"empty signature":                    envelopeRaw("Ed25519", testKeyID, "", canon),
		"not base64url":                      envelopeRaw("Ed25519", testKeyID, "!!!not base64!!!", canon),
		"signature of another document":      envelopeRaw("Ed25519", testKeyID, b64(signedSig(priv, docJSON(testAgentID, 8, "OTHER"))), canon),
		"signed by attacker under trusted id": signed(attackerPriv, testKeyID, canon),
		"wrong key id":                       signed(priv, "cfg-unknown", canon),
		"empty key id":                       signed(priv, "", canon),
		"alg none":                           envelopeRaw("none", testKeyID, sig, canon),
		"alg lower-case":                     envelopeRaw("ed25519", testKeyID, sig, canon),
		"alg HS256":                          envelopeRaw("HS256", testKeyID, sig, canon),
		"alg empty":                          envelopeRaw("", testKeyID, sig, canon),
	}
	for name, env := range cases {
		d, err := Verify(env, trusted(t), testAgentID)
		if err == nil {
			t.Errorf("%s: accepted (%+v)", name, d)
			continue
		}
		var ce *Error
		if !errors.As(err, &ce) || ce.State != StateSignatureInvalid {
			t.Errorf("%s: want State %q, got %v", name, StateSignatureInvalid, err)
		}
	}
}

// Signature check precedes everything else: a forged document for another agent / bad schema must not leak
// a more specific state, and must never be "trusted" enough to be read.
func TestVerify_SignatureChecked_BeforeAgentAndSchema(t *testing.T) {
	_, attacker := newKey(t, "attacker")
	forgedOtherAgent := signed(attacker, testKeyID, docJSON(otherAgentID, 9, "X"))
	_, err := Verify(forgedOtherAgent, trusted(t), testAgentID)
	wantState(t, err, StateSignatureInvalid)

	badSchema := strings.Replace(docJSON(testAgentID, 9, "X"), "lims.bridge.config.v1", "lims.bridge.config.v9", 1)
	_, err = Verify(signed(attacker, testKeyID, badSchema), trusted(t), testAgentID)
	wantState(t, err, StateSignatureInvalid)
}

func TestVerify_WrongAgent(t *testing.T) {
	env := signed(goldenPriv(t), testKeyID, docJSON(otherAgentID, 9, "SIM-CHEM-1"))
	_, err := Verify(env, trusted(t), testAgentID)
	wantState(t, err, StateAgentMismatch)

	// own id differs from the vector's agent
	_, err = Verify(goldenEnvelope(t), trusted(t), otherAgentID)
	wantState(t, err, StateAgentMismatch)

	// no case folding / prefix tricks
	for _, id := range []string{strings.ToUpper(testAgentID), testAgentID + "0", testAgentID[:len(testAgentID)-1], ""} {
		_, err = Verify(goldenEnvelope(t), trusted(t), id)
		wantState(t, err, StateAgentMismatch)
	}
}

func TestVerify_SchemaInvalid_ValidlySigned(t *testing.T) {
	base := docJSON(testAgentID, 7, "SIM-CHEM-1")
	rep := func(old, nw string) string {
		if !strings.Contains(base, old) {
			t.Fatalf("test bug: %q not in base", old)
		}
		return strings.Replace(base, old, nw, 1)
	}
	cases := map[string]string{
		"wrong schema id":        rep(`"schema":"lims.bridge.config.v1"`, `"schema":"lims.bridge.config.v2"`),
		"schema missing":         rep(`"schema":"lims.bridge.config.v1",`, ``),
		"config_version missing": rep(`"config_version":7,`, ``),
		"config_version string":  rep(`"config_version":7`, `"config_version":"7"`),
		"config_version zero":    rep(`"config_version":7`, `"config_version":0`),
		"config_version negative": rep(`"config_version":7`, `"config_version":-1`),
		"instruments not array":  rep(`"instruments":[{"instrument_code":"SIM-CHEM-1"}]`, `"instruments":{}`),
		"document is array":      `[]`,
		"document is null":       `null`,
	}
	for name, doc := range cases {
		_, err := Verify(signed(goldenPriv(t), testKeyID, doc), trusted(t), testAgentID)
		if err == nil {
			t.Errorf("%s: accepted", name)
			continue
		}
		var ce *Error
		if !errors.As(err, &ce) || ce.State != StateSchemaInvalid {
			t.Errorf("%s: want State %q, got %v", name, StateSchemaInvalid, err)
		}
	}
}

// Rotation = release with the new key first (5.10): current + next are both trusted; a retired id is not.
func TestVerify_KeyRotation_CurrentAndNext(t *testing.T) {
	nextPub, nextPriv := newKey(t, "cfg-next")
	keys := TrustedKeys{testKeyID: goldenPub(t), "cfg-next": nextPub}
	canon := docJSON(testAgentID, 11, "SIM-CHEM-1")

	if _, err := Verify(signed(goldenPriv(t), testKeyID, canon), keys, testAgentID); err != nil {
		t.Fatalf("current key: %v", err)
	}
	if _, err := Verify(signed(nextPriv, "cfg-next", canon), keys, testAgentID); err != nil {
		t.Fatalf("next key: %v", err)
	}
	// next key's signature presented under the current key id (key confusion)
	_, err := Verify(signed(nextPriv, testKeyID, canon), keys, testAgentID)
	wantState(t, err, StateSignatureInvalid)
	// agent that only trusts the new key rejects the retired one
	_, err = Verify(signed(goldenPriv(t), testKeyID, canon), TrustedKeys{"cfg-next": nextPub}, testAgentID)
	wantState(t, err, StateSignatureInvalid)
}

func TestVerify_NoTrustedKeys_FailsClosed(t *testing.T) {
	for _, keys := range []TrustedKeys{nil, {}} {
		_, err := Verify(goldenEnvelope(t), keys, testAgentID)
		wantState(t, err, StateSignatureInvalid)
	}
}

func TestVerify_MalformedEnvelopes_RejectedNeverPanic(t *testing.T) {
	canon := docJSON(testAgentID, 7, "SIM-CHEM-1")
	sig := b64(signedSig(goldenPriv(t), canon))
	dup := `{"agent_id":"` + otherAgentID + `","agent_id":"` + testAgentID + `",` + canon[1:]
	cases := map[string][]byte{
		"nil":                nil,
		"empty":              []byte(``),
		"null":               []byte(`null`),
		"array":              []byte(`[]`),
		"empty object":       []byte(`{}`),
		"not json":           []byte(`not json`),
		"alg only":           []byte(`{"alg":"Ed25519"}`),
		"document missing":   []byte(`{"alg":"Ed25519","key_id":"` + testKeyID + `","signature":"` + sig + `"}`),
		"document null":      envelopeRaw("Ed25519", testKeyID, sig, `null`),
		"document string":    envelopeRaw("Ed25519", testKeyID, sig, `"x"`),
		"signature number":   []byte(`{"alg":"Ed25519","key_id":"` + testKeyID + `","signature":1,"document":` + canon + `}`),
		"duplicate key in document (parser differential)": envelopeRaw("Ed25519", testKeyID, sig, dup),
		"truncated envelope": goldenEnvelope(t)[:40],
	}
	for name, env := range cases {
		func() {
			defer func() {
				if r := recover(); r != nil {
					t.Errorf("%s: panic %v", name, r)
				}
			}()
			d, err := Verify(env, trusted(t), testAgentID)
			if err == nil {
				t.Errorf("%s: accepted (%+v)", name, d)
				return
			}
			var ce *Error
			if !errors.As(err, &ce) || !isRejectState(ce.State) {
				t.Errorf("%s: want a reject *Error state, got %v", name, err)
			}
		}()
	}
}

func TestVerify_DoesNotCheckVersionOrState(t *testing.T) {
	// Verify is stateless: any config_version >= 1 verifies; rollback is Apply's job (see apply_test.go).
	for _, v := range []int{1, 2, 7, 1000000} {
		if _, err := Verify(signed(goldenPriv(t), testKeyID, docJSON(testAgentID, v, "A")), trusted(t), testAgentID); err != nil {
			t.Errorf("version %d: %v", v, err)
		}
	}
}
