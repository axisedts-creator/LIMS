package queue

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// AC-05.7 / D-02: the agent is killed (no Close, no checkpoint) after ACKing frame n; frames 1..n must be on disk.
// "ACK n" is printed by the child only after AppendChunk returned, i.e. exactly where the receiver would write the ACK byte.

const crashEnv = "LIMS_QUEUE_CRASH_DB"

func TestCrashChild(t *testing.T) {
	path := os.Getenv(crashEnv)
	if path == "" {
		t.Skip("helper process for TestKillAfterAckKeepsFrames")
	}
	d, err := Open(path, &testProtector{}, Options{FreeBytes: func(string) (int64, error) { return 100 << 30, nil }})
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(2)
	}
	if err := d.BeginSession(Session{ID: "sess-1", InstrumentID: "inst-1", Protocol: "astm",
		StartedAtAgent: "2026-11-11T08:00:00.000Z", LastFrameAtAgent: "2026-11-11T08:00:00.000Z"}); err != nil {
		fmt.Println("ERR", err)
		os.Exit(2)
	}
	for n := 1; n <= 5000; n++ {
		if err := d.AppendChunk("sess-1", n, (n+1)%8, []byte(fmt.Sprintf("frame-%d|", n)), "2026-11-11T08:00:01.000Z"); err != nil {
			fmt.Println("ERR", err)
			os.Exit(2)
		}
		fmt.Println("ACK", n)
	}
	os.Exit(0) // never reached in the test: the parent kills the process first
}

func TestKillAfterAckKeepsFrames(t *testing.T) {
	path := dbPath(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestCrashChild$")
	cmd.Env = append(os.Environ(), crashEnv+"="+path)
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	lastAck := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			f := strings.Fields(sc.Text())
			if len(f) == 2 && f[0] == "ACK" {
				lastAck, _ = strconv.Atoi(f[1])
				if lastAck >= 25 {
					_ = cmd.Process.Kill() // hard kill, like a crash / power loss of the process
					return
				}
			}
			if len(f) >= 1 && f[0] == "ERR" {
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("child did not reach ACK 25 within 60 s")
	}
	_ = cmd.Wait()
	if lastAck < 25 {
		t.Fatalf("child stopped at ACK %d (see ERR line); cannot test the crash", lastAck)
	}

	d := openT(t, path, &testProtector{}, Options{})
	ss, err := d.OpenSessions()
	if err != nil || len(ss) != 1 || ss[0].ID != "sess-1" {
		t.Fatalf("open sessions after crash = %+v %v (restart recovery needs the session)", ss, err)
	}
	ch, err := d.Chunks("sess-1")
	if err != nil {
		t.Fatalf("chunks after crash: %v", err)
	}
	if len(ch) < lastAck {
		t.Fatalf("lost data: %d frames on disk, but frame %d was ACKed", len(ch), lastAck)
	}
	var all strings.Builder
	for i, c := range ch { // contiguous, intact, in order; a frame after lastAck may exist (committed before the kill)
		want := fmt.Sprintf("frame-%d|", i+1)
		if string(c) != want {
			t.Fatalf("frame %d = %q, want %q", i+1, c, want)
		}
		all.WriteString(want)
	}
	s, _ := d.GetSession("sess-1")
	if s.Frames != len(ch) || s.ExpectedFN != (len(ch)+1)%8 {
		t.Errorf("session counters out of step with chunks (one tx per frame): frames=%d expected_fn=%d chunks=%d", s.Frames, s.ExpectedFN, len(ch))
	}

	// Recovery can finalise what was persisted; sha matches the concatenation.
	it, err := d.FinalizeSession("sess-1", in("it-crash", "incomplete", nil))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(all.String()))
	if it.RawSHA256 != hex.EncodeToString(sum[:]) {
		t.Errorf("sha mismatch after recovery")
	}
}

// A committed item survives a kill as well (finalise is one transaction).
func TestKillAfterFinalizeKeepsItem(t *testing.T) {
	if os.Getenv(crashEnv) != "" {
		t.Skip("child")
	}
	path := dbPath(t)
	d, err := Open(path, &testProtector{}, Options{})
	if err != nil {
		t.Fatal(err)
	}
	seedSession(t, d, "S1", 3)
	if _, err := d.FinalizeSession("S1", in("it-1", "data", nil)); err != nil {
		t.Fatal(err)
	}
	// Simulate the crash: no Close. A second handle (as after a restart) must see the committed item.
	d2 := openT(t, path, &testProtector{}, Options{})
	got, err := d2.GetItem("it-1")
	if err != nil || got.State != "pending" || got.SizeBytes == 0 {
		t.Fatalf("committed item not visible after unclean stop: %v %+v", err, got)
	}
	if ss, _ := d2.OpenSessions(); len(ss) != 0 {
		t.Errorf("finalised session still open: %+v", ss)
	}
	_ = d.Close()
}
