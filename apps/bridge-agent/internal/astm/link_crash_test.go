package astm

// AC-05.7 kill test: a child process runs the real Receiver on a real queue file, is hard-killed right after the
// instrument side received the ACK for frame n (no Close, no checkpoint), and a second "process" recovers.
// "ACK n" is printed by the child only after Feed returned the ACK byte, i.e. exactly when the instrument saw it.

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	lkCrashDB   = "LIMS_ASTM_CRASH_DB"
	lkCrashUpTo = "LIMS_ASTM_CRASH_UPTO"
)

func TestLinkCrashChild(t *testing.T) {
	path := os.Getenv(lkCrashDB)
	if path == "" {
		t.Skip("helper process for TestKillAfterAck*")
	}
	upTo, _ := strconv.Atoi(os.Getenv(lkCrashUpTo))
	d, err := lkOpenDBNoT(path)
	if err != nil {
		fmt.Println("ERR", err)
		os.Exit(2)
	}
	n := 0
	rx := NewReceiver(ReceiverConfig{
		InstrumentID: lkInst, Queue: d, Clock: lkSysClock{},
		NewID: func() string { n++; return fmt.Sprintf("child-%03d", n) },
	})
	if got := rx.Feed([]byte{ENQ}); len(got) != 1 || got[0] != ACK {
		fmt.Println("ERR enq reply", got)
		os.Exit(2)
	}
	for i := 1; i <= upTo; i++ {
		f, err := EncodeFrame(i, []byte(lkGoldTexts[i-1]), ETX)
		if err != nil {
			fmt.Println("ERR", err)
			os.Exit(2)
		}
		if got := rx.Feed(f); len(got) != 1 || got[0] != ACK {
			fmt.Println("ERR frame reply", i, got)
			os.Exit(2)
		}
		fmt.Println("ACK", i)
	}
	time.Sleep(60 * time.Second) // the parent kills us here, before any EOT
	os.Exit(0)
}

// lkKillAfter starts the child, waits until it printed "ACK upTo", hard-kills it, and returns the queue path.
func lkKillAfter(t *testing.T, upTo int) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.db")
	cmd := exec.Command(os.Args[0], "-test.run=^TestLinkCrashChild$")
	cmd.Env = append(os.Environ(), lkCrashDB+"="+path, lkCrashUpTo+"="+strconv.Itoa(upTo))
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	last := 0
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			f := strings.Fields(sc.Text())
			if len(f) == 2 && f[0] == "ACK" {
				last, _ = strconv.Atoi(f[1])
				if last >= upTo {
					_ = cmd.Process.Kill() // crash / power loss of the process
					return
				}
			}
			if len(f) >= 1 && f[0] == "ERR" {
				t.Logf("child: %s", sc.Text())
				return
			}
		}
	}()
	select {
	case <-done:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatalf("child did not reach ACK %d within 60 s", upTo)
	}
	_ = cmd.Wait()
	if last < upTo {
		t.Fatalf("child stopped at ACK %d, wanted %d (see child log); cannot test the crash", last, upTo)
	}
	return path
}

func TestKillAfterAckNoLossPartialMessageIsIncomplete(t *testing.T) {
	if os.Getenv(lkCrashDB) != "" {
		t.Skip("child")
	}
	path := lkKillAfter(t, 3)
	r := openLkRig(t, path, "parent-")
	ss := r.openSessions()
	if len(ss) != 1 || ss[0].Frames < 3 {
		t.Fatalf("after the kill: sessions %+v, want the open session with >= 3 frames (frame 3 was ACKed)", ss)
	}
	n, err := r.rx.Recover()
	if err != nil || n != 1 {
		t.Fatalf("Recover = %d, %v", n, err)
	}
	it := r.oneItem()
	if it.Kind != "incomplete" || !strings.HasPrefix(string(it.Raw), strings.Join(lkGoldTexts[:3], "")) {
		t.Fatalf("recovered item = kind %q raw %q: lost an ACKed frame", it.Kind, it.Raw)
	}
	if m := lkMeta(t, it); m.IncompleteReason != "process_restart" {
		t.Errorf("incomplete_reason = %q, want process_restart", m.IncompleteReason)
	}
}

func TestKillAfterLastFrameBeforeEotRecoversCompleteMessageAndResendDedupes(t *testing.T) {
	if os.Getenv(lkCrashDB) != "" {
		t.Skip("child")
	}
	path := lkKillAfter(t, 5) // every frame ACKed, EOT never processed
	r := openLkRig(t, path, "parent-")
	if n, err := r.rx.Recover(); err != nil || n != 1 {
		t.Fatalf("Recover = %d, %v", n, err)
	}
	rec := r.oneItem()
	if rec.Kind != "data" || rec.RawSHA256 != lkGoldSHA {
		t.Fatalf("recovered item = kind %q sha %s, want data with golden sha (L record was the last ACKed frame)", rec.Kind, rec.RawSHA256)
	}
	// the instrument never saw EOT confirmed and re-sends the whole message: same (instrument, sha256(raw)) -> server dedupe (04 N10)
	stream, want := lkWholeMessage(t)
	r.mustReply("re-sent message", stream, want)
	its := r.items()
	if len(its) != 2 || its[1].InstrumentID != rec.InstrumentID || its[1].RawSHA256 != rec.RawSHA256 {
		t.Fatalf("items = %+v, want the re-sent message to carry the same instrument and sha256 as the recovered one", its)
	}
}
