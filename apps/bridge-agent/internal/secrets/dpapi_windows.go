package secrets

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Scope selects the DPAPI key. Spike S1 (AG-T02, LD-94): user scope is the primary path; machine scope
// (CRYPTPROTECT_LOCAL_MACHINE) is the fallback only, and then the file ACL is the only protection.
type Scope int

const (
	ScopeUser Scope = iota
	ScopeMachine
)

// DPAPI wraps secrets with CryptProtectData / CryptUnprotectData. Entropy (optional, e.g. the agent id) must match on unwrap.
type DPAPI struct {
	scope   Scope
	entropy []byte
}

func NewDPAPI(scope Scope, entropy []byte) *DPAPI {
	return &DPAPI{scope: scope, entropy: append([]byte(nil), entropy...)}
}

func (d *DPAPI) flags() uint32 {
	f := uint32(windows.CRYPTPROTECT_UI_FORBIDDEN)
	if d.scope == ScopeMachine {
		f |= windows.CRYPTPROTECT_LOCAL_MACHINE
	}
	return f
}

func (d *DPAPI) entropyBlob() *windows.DataBlob {
	if len(d.entropy) == 0 {
		return nil
	}
	return &windows.DataBlob{Size: uint32(len(d.entropy)), Data: &d.entropy[0]}
}

func takeBlob(out *windows.DataBlob) []byte {
	b := append([]byte(nil), unsafe.Slice(out.Data, out.Size)...)
	_, _ = windows.LocalFree(windows.Handle(unsafe.Pointer(out.Data)))
	return b
}

func (d *DPAPI) Protect(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, errors.New("secrets: nothing to protect")
	}
	in := windows.DataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var out windows.DataBlob
	if err := windows.CryptProtectData(&in, nil, d.entropyBlob(), 0, nil, d.flags(), &out); err != nil {
		return nil, fmt.Errorf("CryptProtectData: %w", err)
	}
	return takeBlob(&out), nil
}

func (d *DPAPI) Unprotect(blob []byte) ([]byte, error) {
	if len(blob) == 0 {
		return nil, errors.New("secrets: empty blob")
	}
	in := windows.DataBlob{Size: uint32(len(blob)), Data: &blob[0]}
	var out windows.DataBlob
	if err := windows.CryptUnprotectData(&in, nil, d.entropyBlob(), 0, nil, windows.CRYPTPROTECT_UI_FORBIDDEN, &out); err != nil {
		return nil, fmt.Errorf("CryptUnprotectData: %w", err)
	}
	return takeBlob(&out), nil
}
