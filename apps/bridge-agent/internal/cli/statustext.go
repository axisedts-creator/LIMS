package cli

import (
	"fmt"
	"os"
	"time"

	"lims/apps/bridge-agent/internal/status"
)

// ago renders an RFC 3339 time as "12 s ago" relative to now; an unparseable or empty value is shown as is / "never".
func ago(ts string, now time.Time) string {
	if ts == "" {
		return "never"
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return clean(ts)
	}
	s := int(now.Sub(t).Seconds())
	switch {
	case s < 0:
		return clean(ts)
	case s < 120:
		return fmt.Sprintf("%d s ago", s)
	case s < 2*3600:
		return fmt.Sprintf("%d min ago", s/60)
	case s < 2*86400:
		return fmt.Sprintf("%d h ago", s/3600)
	}
	return fmt.Sprintf("%d d ago", s/86400)
}

func printStatus(d Deps, st status.Status) {
	now := d.Now()
	reach := "unreachable"
	if st.ServerReachable {
		reach = "reachable"
	}
	w := d.Out
	fmt.Fprintf(w, "LIMS Bridge Agent %s (launcher %s)    Service: %s\n", clean(st.AgentVersion), clean(st.LauncherVersion), clean(st.ServiceState))
	fmt.Fprintf(w, "Agent: %s    Auth: %s\n", clean(st.AgentID), clean(st.AuthState))
	fmt.Fprintf(w, "Server: %s (last heartbeat %s, %s)\n", reach, ago(st.LastHeartbeatAt, now), clean(st.LastHeartbeatOutcome))
	fmt.Fprintf(w, "Config: version %d (%s)    Update: %s\n", st.ConfigVersion, clean(st.ConfigState), clean(st.UpdateState))
	q := st.Queue
	fmt.Fprintf(w, "Queue: pending %d | uploading %d | rejected %d | oversize %d | retained %d\n", q.Pending, q.Uploading, q.Rejected, q.Oversize, q.UploadedRetained)
	if q.Pending > 0 {
		fmt.Fprintf(w, "Oldest pending: %d s\n", q.OldestPendingAgeSeconds)
	}
	fmt.Fprintf(w, "Disk free on queue volume: %d MB\n", st.DiskFreeMB)
	// The service rewrites the file every status.Interval; an old file means the service is stopped or stuck.
	if fi, err := os.Stat(d.Env.Layout.StatusFile()); err == nil {
		if age := now.Sub(fi.ModTime()); age > 6*status.Interval && age < 24*time.Hour {
			fmt.Fprintf(w, "WARNING: status.json was last written %d s ago; the service may be stopped.\n", int(age.Seconds()))
		}
	}
	fmt.Fprintln(w)
	printInstruments(d, st)
}

func printInstruments(d Deps, st status.Status) {
	w := d.Out
	fmt.Fprintln(w, "Instruments")
	if len(st.Instruments) == 0 {
		fmt.Fprintln(w, "  none configured")
		return
	}
	now := d.Now()
	for _, in := range st.Instruments {
		line := fmt.Sprintf("  %s  %s  last message %s  today %d", clean(in.InstrumentCode), clean(in.LinkState), ago(in.LastMessageAtAgent, now), in.MessagesToday)
		if in.LastErrorCode != "" {
			line += "  last error " + clean(in.LastErrorCode)
		}
		fmt.Fprintln(w, line)
	}
}
