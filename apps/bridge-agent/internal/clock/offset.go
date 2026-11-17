// Package clock estimates the agent's wall-clock offset from the LIMS server (TRD 5.9, AC-14.1).
package clock

import (
	"sync"
	"time"
)

// Window is how long a sample stays eligible for Current.
const Window = 10 * time.Minute

// Compute returns offset = server_time - (tSend+tRecv)/2 and uncertainty = (tRecv-tSend)/2, both in whole ms.
// A positive offset means the agent clock is behind the server.
func Compute(tSend, tRecv, serverTime time.Time) (offsetMs, uncertaintyMs int64) {
	rtt := tRecv.Sub(tSend)
	mid := tSend.Add(rtt / 2)
	return serverTime.Sub(mid).Milliseconds(), (rtt / 2).Milliseconds()
}

type sample struct {
	at       time.Time // tRecv
	off, unc int64
}

// Estimator keeps the sample with the smallest uncertainty seen in the last Window.
type Estimator struct {
	mu      sync.Mutex
	samples []sample
}

func NewEstimator() *Estimator { return &Estimator{} }

// Observe records one request/response pair. A response that arrived before it was sent is ignored.
func (e *Estimator) Observe(tSend, tRecv, serverTime time.Time) {
	if tRecv.Before(tSend) {
		return
	}
	off, unc := Compute(tSend, tRecv, serverTime)
	e.mu.Lock()
	defer e.mu.Unlock()
	kept := e.samples[:0]
	for _, s := range e.samples {
		if tRecv.Sub(s.at) <= Window {
			kept = append(kept, s)
		}
	}
	e.samples = append(kept, sample{tRecv, off, unc})
}

// Current returns the best sample no older than Window at now; ok=false when there is none.
func (e *Estimator) Current(now time.Time) (offsetMs, uncertaintyMs int64, ok bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, s := range e.samples {
		if now.Sub(s.at) > Window {
			continue
		}
		if !ok || s.unc <= uncertaintyMs {
			offsetMs, uncertaintyMs, ok = s.off, s.unc, true
		}
	}
	return
}
