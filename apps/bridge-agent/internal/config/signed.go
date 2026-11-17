package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"strconv"
)

// config_state values, identical to the agent_status.config_state CHECK (05-SCHEMA).
const (
	StateOK               = "ok"
	StateSignatureInvalid = "signature_invalid"
	StateAgentMismatch    = "agent_mismatch"
	StateRollbackRejected = "rollback_rejected"
	StateSchemaInvalid    = "schema_invalid"
)

const (
	algEd25519 = "Ed25519"
	schemaV1   = "lims.bridge.config.v1"
)

// Envelope is the wire form returned by getAgentConfig (02-TRD 5.10).
type Envelope struct {
	Alg       string          `json:"alg"`
	KeyID     string          `json:"key_id"`
	Signature string          `json:"signature"`
	Document  json.RawMessage `json:"document"`
}

// Error is a rejected config; State is the config_state to report in the next heartbeat.
type Error struct{ State, Reason string }

func (e *Error) Error() string { return "config rejected (" + e.State + "): " + e.Reason }

func reject(state, reason string) error { return &Error{State: state, Reason: reason} }

// Document is a verified config document. Raw is its canonical JSON.
type Document struct {
	KeyID, AgentID, CanonicalSHA256 string
	ConfigVersion                   int64
	Raw                             json.RawMessage
}

// Verify checks, in fail-closed order: alg, key_id in keys, Ed25519 signature over canonical(document)
// (nothing in the document is read before this passes), agent_id == agentID, schema.
// It never looks at config_version ordering; rollback is Applier's job.
func Verify(envelope []byte, keys TrustedKeys, agentID string) (*Document, error) {
	// Canonicalizing the whole envelope also rejects duplicate keys; the canonical document is then a sub-slice.
	canonEnv, err := Canonicalize(envelope)
	if err != nil {
		return nil, reject(StateSignatureInvalid, "envelope: "+err.Error())
	}
	var m map[string]json.RawMessage // exact-case key match (encoding/json struct decoding folds case)
	if json.Unmarshal(canonEnv, &m) != nil {
		return nil, reject(StateSignatureInvalid, "envelope is not an object")
	}
	var env Envelope
	if json.Unmarshal(m["alg"], &env.Alg) != nil || json.Unmarshal(m["key_id"], &env.KeyID) != nil ||
		json.Unmarshal(m["signature"], &env.Signature) != nil || len(m["document"]) == 0 {
		return nil, reject(StateSignatureInvalid, "envelope fields missing or mistyped")
	}
	env.Document = m["document"]

	if env.Alg != algEd25519 {
		return nil, reject(StateSignatureInvalid, "unsupported alg")
	}
	pub, ok := keys[env.KeyID]
	if !ok || len(pub) != ed25519.PublicKeySize {
		return nil, reject(StateSignatureInvalid, "key_id not trusted")
	}
	sig, err := base64.RawURLEncoding.Strict().DecodeString(env.Signature)
	if err != nil || len(sig) != ed25519.SignatureSize || !ed25519.Verify(pub, env.Document, sig) {
		return nil, reject(StateSignatureInvalid, "signature does not verify")
	}

	// Signature is good: the document is trusted from here on.
	var d map[string]json.RawMessage
	if json.Unmarshal(env.Document, &d) != nil || d == nil {
		return nil, reject(StateSchemaInvalid, "document is not an object")
	}
	var doc Document
	if json.Unmarshal(d["agent_id"], &doc.AgentID) != nil {
		return nil, reject(StateSchemaInvalid, "agent_id missing")
	}
	if doc.AgentID != agentID {
		return nil, reject(StateAgentMismatch, "document is for another agent")
	}
	var schema string
	if json.Unmarshal(d["schema"], &schema) != nil || schema != schemaV1 {
		return nil, reject(StateSchemaInvalid, "unknown schema")
	}
	if doc.ConfigVersion, err = strconv.ParseInt(string(d["config_version"]), 10, 64); err != nil || doc.ConfigVersion < 1 {
		return nil, reject(StateSchemaInvalid, "config_version must be an integer >= 1")
	}
	if len(d["instruments"]) == 0 || d["instruments"][0] != '[' {
		return nil, reject(StateSchemaInvalid, "instruments must be an array")
	}
	doc.KeyID = env.KeyID
	doc.Raw = env.Document
	doc.CanonicalSHA256, _ = CanonicalSHA256(env.Document)
	return &doc, nil
}
