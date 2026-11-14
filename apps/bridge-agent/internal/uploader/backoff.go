package uploader

import (
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	backoffBase = time.Second
	backoffCap  = 5 * time.Minute
	// maxRetryAfter bounds a hostile or buggy header; the cap is above the 5 min backoff cap on purpose (AC-08.2).
	maxRetryAfter = 24 * time.Hour
)

// Backoff is 1 s doubling to 5 min with +-20 % jitter. The zero value uses math/rand.
type Backoff struct{ rnd func() float64 }

// NewBackoff takes a [0,1) source for jitter; nil uses math/rand.
func NewBackoff(rnd func() float64) Backoff { return Backoff{rnd} }

// Delay is the wait before retry number attempt (0-based). A larger Retry-After wins and is not jittered or capped.
func (b Backoff) Delay(attempt int, retryAfter time.Duration) time.Duration {
	d := backoffCap
	if attempt < 9 { // 1 s << 9 = 512 s is already past the cap
		if attempt < 0 {
			attempt = 0
		}
		d = min(backoffBase<<attempt, backoffCap)
	}
	r := rand.Float64
	if b.rnd != nil {
		r = b.rnd
	}
	d = time.Duration(float64(d) * (1 + (r()-0.5)*0.4))
	return max(d, retryAfter)
}

// ParseRetryAfter reads delta-seconds or an HTTP date. ok=false for anything else.
func ParseRetryAfter(h string, now time.Time) (time.Duration, bool) {
	h = strings.TrimSpace(h)
	if h == "" {
		return 0, false
	}
	if strings.IndexFunc(h, func(r rune) bool { return r < '0' || r > '9' }) < 0 {
		n, err := strconv.ParseUint(h, 10, 32)
		if err != nil { // too many digits: far beyond the bound
			return maxRetryAfter, true
		}
		return min(time.Duration(n)*time.Second, maxRetryAfter), true
	}
	t, err := http.ParseTime(h)
	if err != nil {
		return 0, false
	}
	return min(max(t.Sub(now), 0), maxRetryAfter), true
}

// Class partitions the 60 requests/min budget (TRD 5.7).
type Class int

const (
	ClassUpload Class = iota
	ClassHostQuery
	ClassHeartbeat
)

var classPerMinute = [...]float64{ClassUpload: 38, ClassHostQuery: 20, ClassHeartbeat: 2}

// RateBudget is one token bucket per class, each refilling continuously over a minute.
type RateBudget struct {
	mu     sync.Mutex
	now    func() time.Time
	last   time.Time
	tokens [len(classPerMinute)]float64
}

func NewRateBudget(now func() time.Time) *RateBudget {
	if now == nil {
		now = time.Now
	}
	rb := &RateBudget{now: now, last: now()}
	copy(rb.tokens[:], classPerMinute[:])
	return rb
}

// Allow takes one token of the class if available.
func (rb *RateBudget) Allow(c Class) bool {
	if c < 0 || int(c) >= len(classPerMinute) {
		return false
	}
	rb.mu.Lock()
	defer rb.mu.Unlock()
	now := rb.now()
	if el := now.Sub(rb.last); el > 0 {
		for i, per := range classPerMinute {
			rb.tokens[i] = min(per, rb.tokens[i]+per*el.Seconds()/60)
		}
		rb.last = now
	}
	if rb.tokens[c] < 1 {
		return false
	}
	rb.tokens[c]--
	return true
}
