package update_test

// AC-15.3 (first half): the launcher switches only when no link session has been active for 60 s and, if set, inside the
// tenant update window. Window = { from "HH:MM", to "HH:MM", timezone IANA }, to < from spans midnight (02-TRD 5.10).
import (
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/update"
)

func TestReadyToApply(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	utc := func(from, to string) *update.Window { return &update.Window{From: from, To: to, Timezone: "UTC"} }
	cases := []struct {
		name     string
		now      time.Time
		last     time.Time
		sessions int
		w        *update.Window
		want     bool
	}{
		{"idle 61 s, no window", now, now.Add(-61 * time.Second), 0, nil, true},
		{"idle exactly 60 s", now, now.Add(-60 * time.Second), 0, nil, true},
		{"idle 59 s", now, now.Add(-59 * time.Second), 0, nil, false},
		{"no activity ever (zero time)", now, time.Time{}, 0, nil, true},
		{"active session blocks even with old last activity", now, now.Add(-time.Hour), 1, nil, false},
		{"inside 09:00-17:00", now, now.Add(-time.Hour), 0, utc("09:00", "17:00"), true},
		{"outside 09:00-17:00", now.Add(8 * time.Hour), now.Add(-time.Hour), 0, utc("09:00", "17:00"), false},
		{"window from is inclusive", time.Date(2026, 11, 11, 9, 0, 0, 0, time.UTC), time.Time{}, 0, utc("09:00", "17:00"), true},
		{"window to is exclusive", time.Date(2026, 11, 11, 17, 0, 0, 0, time.UTC), time.Time{}, 0, utc("09:00", "17:00"), false},
		{"overnight window 22:00-02:00, 23:30", time.Date(2026, 11, 11, 23, 30, 0, 0, time.UTC), time.Time{}, 0, utc("22:00", "02:00"), true},
		{"overnight window 22:00-02:00, 01:00", time.Date(2026, 11, 12, 1, 0, 0, 0, time.UTC), time.Time{}, 0, utc("22:00", "02:00"), true},
		{"overnight window 22:00-02:00, 12:00", time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC), time.Time{}, 0, utc("22:00", "02:00"), false},
		// Asia/Kathmandu is UTC+05:45: 21:00Z = 02:45 local, 10:00Z = 15:45 local.
		{"timezone honoured: inside in Kathmandu", time.Date(2026, 11, 11, 21, 0, 0, 0, time.UTC), time.Time{}, 0,
			&update.Window{From: "02:00", To: "04:00", Timezone: "Asia/Kathmandu"}, true},
		{"timezone honoured: outside in Kathmandu", now, time.Time{}, 0,
			&update.Window{From: "02:00", To: "04:00", Timezone: "Asia/Kathmandu"}, false},
		{"window ok but a session is active", now, now.Add(-time.Hour), 2, utc("09:00", "17:00"), false},
		{"window closed although idle", now.Add(8 * time.Hour), now.Add(-time.Hour), 0, utc("09:00", "17:00"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := update.ReadyToApply(c.now, c.last, c.sessions, c.w)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != c.want {
				t.Fatalf("ReadyToApply = %v, want %v", got, c.want)
			}
		})
	}
}

// A malformed window must fail closed (do not apply) and say why.
func TestReadyToApplyBadWindowFailsClosed(t *testing.T) {
	now := time.Date(2026, 11, 11, 10, 0, 0, 0, time.UTC)
	for _, w := range []*update.Window{
		{From: "09:00", To: "17:00", Timezone: "Mars/Olympus"},
		{From: "25:00", To: "17:00", Timezone: "UTC"},
		{From: "09:00", To: "9am", Timezone: "UTC"},
		{From: "", To: "", Timezone: "UTC"},
	} {
		got, err := update.ReadyToApply(now, time.Time{}, 0, w)
		if got || err == nil {
			t.Fatalf("window %+v: ReadyToApply = (%v, %v), want (false, error)", *w, got, err)
		}
	}
}
