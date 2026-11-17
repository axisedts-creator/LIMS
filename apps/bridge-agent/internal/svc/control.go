package svc

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

// Triggers are what the service does when the CLI asks. Nil funcs are allowed.
type Triggers struct{ HeartbeatNow, FlushNow func() }

// HandleControl serves the user-defined control codes of 02-TRD 5.12: 128 heartbeat now, 129 flush uploads now. Any other code
// is not handled and fires nothing.
func HandleControl(code uint32, t Triggers) bool {
	switch code {
	case CtlHeartbeatNow:
		if t.HeartbeatNow != nil {
			t.HeartbeatNow()
		}
		return true
	case CtlFlushNow:
		if t.FlushNow != nil {
			t.FlushNow()
		}
		return true
	}
	return false
}

const maxRequestBytes = 4 << 10 // a request is {"kind":"..."}; anything bigger is garbage

type request struct {
	Kind string `json:"kind"`
}

func knownKind(k string) bool { return k == RequestHeartbeatNow || k == RequestFlushNow }

// WriteRequest is the CLI fallback when the control code cannot be delivered: it atomically drops status\request.json. The status
// directory must already exist (the installer creates it with its ACL); it is never created here.
func WriteRequest(statusDir, kind string) error {
	if !knownKind(kind) {
		return fmt.Errorf("svc: unknown request kind")
	}
	raw, _ := json.Marshal(request{Kind: kind})
	tmp, err := os.CreateTemp(statusDir, "request-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, err = tmp.Write(raw)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(statusDir, RequestFile))
	}
	if err != nil {
		_ = os.Remove(name)
	}
	return err
}

var (
	claimSeq  atomic.Uint64
	consumeMu sync.Mutex
)

func removeRetry(p string) {
	for i := 0; i < 50; i++ {
		if err := os.Remove(p); err == nil || errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(time.Millisecond)
	}
}

// ConsumeRequest claims request.json at most once (rename to a private name), deletes it and fires the matching trigger. The file
// is untrusted input: anything that is not a small JSON object with a known kind is deleted and fires nothing.
func ConsumeRequest(statusDir string, t Triggers) (bool, error) {
	consumeMu.Lock() // in-process consumers take turns (cheap and fast); the rename below still guards against another process
	defer consumeMu.Unlock()
	p := filepath.Join(statusDir, RequestFile)
	fi, err := os.Lstat(p)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fi.Mode().IsRegular() {
		return false, fmt.Errorf("svc: %s is not a regular file", RequestFile)
	}
	claim := filepath.Join(statusDir, fmt.Sprintf("request-claim-%d-%d.tmp", os.Getpid(), claimSeq.Add(1)))
	// Windows refuses a rename while another consumer is renaming/opening the same file (sharing violation), so "rename failed" is
	// not "somebody else won": retry until the file is gone (lost the race) or the rename works (won).
	for tries := 0; ; tries++ {
		err := os.Rename(p, claim)
		if err == nil {
			break
		}
		if _, serr := os.Lstat(p); errors.Is(serr, os.ErrNotExist) {
			return false, nil // another consumer won
		}
		if tries >= 200 {
			return false, err
		}
		time.Sleep(time.Millisecond)
	}
	defer removeRetry(claim)
	var f *os.File
	for tries := 0; ; tries++ { // a losing consumer may still hold a handle for a moment (sharing violation)
		if f, err = os.Open(claim); err == nil {
			break
		}
		if tries >= 200 {
			return false, err
		}
		time.Sleep(time.Millisecond)
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxRequestBytes+1))
	f.Close()
	if err != nil {
		return false, err
	}
	if len(raw) > maxRequestBytes {
		return false, fmt.Errorf("svc: %s too large, ignored", RequestFile)
	}
	var r request
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&r); err != nil {
		return false, fmt.Errorf("svc: %s is not a valid request, ignored", RequestFile)
	}
	if _, err := dec.Token(); err != io.EOF { // trailing junk
		return false, fmt.Errorf("svc: %s has trailing data, ignored", RequestFile)
	}
	switch r.Kind {
	case RequestHeartbeatNow:
		if t.HeartbeatNow != nil {
			t.HeartbeatNow()
		}
	case RequestFlushNow:
		if t.FlushNow != nil {
			t.FlushNow()
		}
	default:
		return false, fmt.Errorf("svc: %s has an unknown kind, ignored", RequestFile)
	}
	return true, nil
}

// PollRequests runs ConsumeRequest every `every` (RequestPollInterval in the service) until ctx is done.
func PollRequests(ctx context.Context, statusDir string, t Triggers, every time.Duration) {
	tk := time.NewTicker(every)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tk.C:
			if ctx.Err() != nil {
				return
			}
			_, _ = ConsumeRequest(statusDir, t)
		}
	}
}
