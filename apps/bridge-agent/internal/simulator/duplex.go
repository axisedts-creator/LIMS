package simulator

import (
	"errors"
	"io"
	"sync"
	"time"
)

// duplex is the in-memory line between the simulated instrument and mllp.Serve. exchange feeds bytes and waits until the
// agent is blocked in Read again with nothing left to read, so "what the agent wrote in reply" is deterministic.
type duplex struct {
	mu       sync.Mutex
	cond     *sync.Cond
	in, out  []byte
	idle     bool // the reader is blocked with an empty buffer
	closed   bool
	timedOut bool
}

func newDuplex() *duplex {
	d := &duplex{}
	d.cond = sync.NewCond(&d.mu)
	return d
}

// Read is the agent's side of the line.
func (d *duplex) Read(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for len(d.in) == 0 && !d.closed {
		d.idle = true
		d.cond.Broadcast()
		d.cond.Wait()
	}
	if len(d.in) == 0 {
		return 0, io.EOF
	}
	d.idle = false
	n := copy(p, d.in)
	d.in = d.in[n:]
	return n, nil
}

func (d *duplex) Write(p []byte) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed {
		return 0, io.ErrClosedPipe
	}
	d.out = append(d.out, p...)
	return len(p), nil
}

func (d *duplex) Close() error {
	d.mu.Lock()
	d.closed = true
	d.cond.Broadcast()
	d.mu.Unlock()
	return nil
}

func (d *duplex) isClosed() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.closed }

// exchange writes b to the agent, waits for it to go idle (or to close the line) and returns what it wrote.
func (d *duplex) exchange(b []byte) ([]byte, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.in = append(d.in, b...)
	d.idle, d.timedOut = false, false
	d.cond.Broadcast()
	t := time.AfterFunc(realTimeout, func() {
		d.mu.Lock()
		d.timedOut = true
		d.cond.Broadcast()
		d.mu.Unlock()
	})
	defer t.Stop()
	for !d.idle && !d.closed && !d.timedOut {
		d.cond.Wait()
	}
	out := d.out
	d.out = nil
	if d.timedOut && !d.idle && !d.closed {
		return out, errors.New("the agent's link layer did not go idle")
	}
	return out, nil
}
