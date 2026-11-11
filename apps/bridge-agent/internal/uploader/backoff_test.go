package uploader_test

import (
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

func mid() float64 { return 0.5 } // jitter factor exactly 1.0

// AC-08.2: 1 s doubling to 5 min, +-20 % jitter.
func TestBackoff_DoublesFromOneSecondAndCapsAtFiveMinutes(t *testing.T) {
	b := uploader.NewBackoff(mid)
	want := []time.Duration{1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300}
	for n, w := range want {
		if got := b.Delay(n, 0); got != w*time.Second {
			t.Errorf("attempt %d: %v, want %v", n, got, w*time.Second)
		}
	}
	if got := b.Delay(1<<20, 0); got != 300*time.Second {
		t.Errorf("huge attempt must not overflow, got %v", got)
	}
}

func TestBackoff_JitterWithinPlusMinusTwentyPercent(t *testing.T) {
	lo, hi := uploader.NewBackoff(func() float64 { return 0 }), uploader.NewBackoff(func() float64 { return 0.999999 })
	for _, n := range []int{0, 3, 8, 20} {
		base := uploader.NewBackoff(mid).Delay(n, 0)
		if d := lo.Delay(n, 0); d < time.Duration(float64(base)*0.79) || d > time.Duration(float64(base)*0.81) {
			t.Errorf("attempt %d low jitter %v vs base %v", n, d, base)
		}
		if d := hi.Delay(n, 0); d < time.Duration(float64(base)*1.19) || d > time.Duration(float64(base)*1.21) {
			t.Errorf("attempt %d high jitter %v vs base %v", n, d, base)
		}
	}
}

func TestBackoff_DefaultRandIsJittered(t *testing.T) {
	b := uploader.NewBackoff(nil)
	seen := map[time.Duration]bool{}
	for i := 0; i < 50; i++ {
		d := b.Delay(4, 0) // 16 s +-20 %
		if d < 12800*time.Millisecond || d > 19200*time.Millisecond {
			t.Fatalf("delay %v outside 16 s +-20 %%", d)
		}
		seen[d] = true
	}
	if len(seen) < 2 {
		t.Fatal("no jitter applied with the default random source")
	}
}

// AC-08.2: Retry-After honoured; overrides when larger, never shortens the backoff.
func TestBackoff_RetryAfterOverridesWhenLarger(t *testing.T) {
	b := uploader.NewBackoff(mid)
	if got := b.Delay(0, 30*time.Second); got != 30*time.Second {
		t.Errorf("retry-after 30 s at attempt 0: %v", got)
	}
	if got := b.Delay(0, 900*time.Second); got != 900*time.Second {
		t.Errorf("retry-after above the 5 min cap must still be honoured: %v", got)
	}
	if got := b.Delay(5, 2*time.Second); got != 32*time.Second {
		t.Errorf("smaller retry-after must not shorten backoff: %v", got)
	}
}

func TestParseRetryAfter(t *testing.T) {
	now := t0
	cases := []struct {
		in   string
		want time.Duration
		ok   bool
	}{
		{"7", 7 * time.Second, true},
		{"0", 0, true},
		{" 30 ", 30 * time.Second, true},
		{"Fri, 06 Nov 2026 04:01:00 GMT", time.Minute, true},
		{"Fri, 06 Nov 2026 03:00:00 GMT", 0, true}, // date in the past
		{"", 0, false},
		{"soon", 0, false},
		{"-5", 0, false},
		{"1.5", 0, false},
	}
	for _, c := range cases {
		got, ok := uploader.ParseRetryAfter(c.in, now)
		if ok != c.ok || got != c.want {
			t.Errorf("%q: got (%v,%v) want (%v,%v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

// TRD 5.7: 60 requests/min total; 20 reserved for host queries, 2 for heartbeats; uploads use the remainder (38).
func TestRateBudget_SplitAndTotal(t *testing.T) {
	fc := &fakeClock{t: t0}
	rb := uploader.NewRateBudget(fc.Now)
	take := func(c uploader.Class) int {
		n := 0
		for rb.Allow(c) {
			n++
			if n > 1000 {
				t.Fatal("budget unbounded")
			}
		}
		return n
	}
	if n := take(uploader.ClassUpload); n != 38 {
		t.Errorf("uploads per minute = %d, want 38", n)
	}
	if n := take(uploader.ClassHostQuery); n != 20 {
		t.Errorf("host queries per minute = %d, want 20", n)
	}
	if n := take(uploader.ClassHeartbeat); n != 2 {
		t.Errorf("heartbeats per minute = %d, want 2", n)
	}
}

func TestRateBudget_RefillsContinuously(t *testing.T) {
	fc := &fakeClock{t: t0}
	rb := uploader.NewRateBudget(fc.Now)
	for rb.Allow(uploader.ClassUpload) {
	}
	fc.Advance(2 * time.Second) // 38/60 per s -> 1.27 tokens
	if !rb.Allow(uploader.ClassUpload) {
		t.Fatal("one token should have refilled after 2 s")
	}
	if rb.Allow(uploader.ClassUpload) {
		t.Fatal("only one token after 2 s")
	}
	fc.Advance(time.Minute)
	n := 0
	for rb.Allow(uploader.ClassUpload) {
		n++
	}
	if n != 38 {
		t.Fatalf("after a full minute the bucket holds 38, got %d (must not exceed capacity)", n)
	}
}

func TestRateBudget_ClassesAreIndependent(t *testing.T) {
	rb := uploader.NewRateBudget((&fakeClock{t: t0}).Now)
	for rb.Allow(uploader.ClassUpload) {
	}
	if !rb.Allow(uploader.ClassHostQuery) || !rb.Allow(uploader.ClassHeartbeat) {
		t.Fatal("exhausted uploads must not starve host queries or heartbeats")
	}
}
