package clock_test

import (
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/clock"
)

var t0 = time.Date(2026, 11, 6, 4, 0, 0, 0, time.UTC)

// AC-14.1: offset = server_time - (t_send + t_recv)/2 ; uncertainty = (t_recv - t_send)/2 (TRD 5.9).
func TestCompute_NTPMidpoint(t *testing.T) {
	cases := []struct {
		name              string
		send, recv, srv   time.Duration
		wantOff, wantUncs int64
	}{
		{"agent 5 s behind", 0, 200 * time.Millisecond, 5100 * time.Millisecond, 5000, 100},
		{"agent 3 s ahead", 0, 400 * time.Millisecond, -2800 * time.Millisecond, -3000, 200},
		{"in sync", 0, 100 * time.Millisecond, 50 * time.Millisecond, 0, 50},
		{"zero rtt", time.Second, time.Second, 2 * time.Second, 1000, 0},
	}
	for _, c := range cases {
		off, unc := clock.Compute(t0.Add(c.send), t0.Add(c.recv), t0.Add(c.srv))
		if off != c.wantOff || unc != c.wantUncs {
			t.Errorf("%s: off=%d unc=%d, want %d/%d", c.name, off, unc, c.wantOff, c.wantUncs)
		}
	}
}

func TestEstimator_NoSampleNotOK(t *testing.T) {
	if _, _, ok := clock.NewEstimator().Current(t0); ok {
		t.Fatal("estimator without samples must report ok=false")
	}
}

// TRD 5.9: keep the estimate with the smallest uncertainty in the last 10 min.
func TestEstimator_KeepsSmallestUncertaintyInTenMinutes(t *testing.T) {
	e := clock.NewEstimator()
	obs := func(at time.Duration, rtt time.Duration, off time.Duration) {
		send := t0.Add(at)
		e.Observe(send, send.Add(rtt), send.Add(rtt/2+off))
	}
	// uncertainties: 500, 50 (best), 300 ms
	obs(0, time.Second, 4*time.Second)
	obs(time.Minute, 100*time.Millisecond, 4100*time.Millisecond)
	obs(2*time.Minute, 600*time.Millisecond, 3900*time.Millisecond)
	off, unc, ok := e.Current(t0.Add(3 * time.Minute))
	if !ok || off != 4100 || unc != 50 {
		t.Fatalf("at 3 min: off=%d unc=%d ok=%v, want 4100/50", off, unc, ok)
	}
	// best sample (t=1 min) is >10 min old at t=11m01s: fall back to the best remaining one (t=2 min, unc 300)
	off, unc, ok = e.Current(t0.Add(11*time.Minute + time.Second))
	if !ok || off != 3900 || unc != 300 {
		t.Fatalf("at 11 min: off=%d unc=%d ok=%v, want 3900/300", off, unc, ok)
	}
}

func TestEstimator_NewSampleWithSmallerUncertaintyWins(t *testing.T) {
	e := clock.NewEstimator()
	e.Observe(t0, t0.Add(2*time.Second), t0.Add(time.Second+7*time.Second)) // off 7000 unc 1000
	e.Observe(t0.Add(time.Second), t0.Add(time.Second+20*time.Millisecond), t0.Add(time.Second+10*time.Millisecond+6*time.Second))
	off, unc, ok := e.Current(t0.Add(2 * time.Second))
	if !ok || off != 6000 || unc != 10 {
		t.Fatalf("off=%d unc=%d ok=%v", off, unc, ok)
	}
}

// A response that claims to arrive before it was sent is garbage and must not poison the estimate.
func TestEstimator_IgnoresNegativeRoundTrip(t *testing.T) {
	e := clock.NewEstimator()
	e.Observe(t0.Add(time.Second), t0, t0)
	if _, _, ok := e.Current(t0.Add(time.Second)); ok {
		t.Fatal("sample with t_recv < t_send accepted")
	}
}
