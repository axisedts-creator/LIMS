package main_test

// cmd/launcher = bridge-launcher.exe, the binary registered with the SCM (02-TRD 5.11/5.12). Its logic lives in internal/update and is
// tested there; this proves the command itself exists, builds for Windows, and stays small and local.
import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestLauncherCommandBuildsForWindows(t *testing.T) {
	out := filepath.Join(t.TempDir(), "bridge-launcher.exe")
	cmd := exec.Command("go", "build", "-o", out, ".")
	cmd.Env = append(os.Environ(), "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build ./cmd/launcher: %v\n%s", err, b)
	}
	if st, err := os.Stat(out); err != nil || st.Size() == 0 {
		t.Fatalf("no launcher binary produced: %v", err)
	}
}

// The launcher is the trust anchor (REQ-SEC-116/119): the agent must not be able to swap it, and it must not be able to run the agent
// from an unverified location. It may only touch the agent through internal/update.
func TestLauncherMainUsesUpdatePackage(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("cmd/launcher/main.go missing: %v", err)
	}
	if !strings.Contains(string(b), "lims/apps/bridge-agent/internal/update") {
		t.Fatal("main.go must delegate verification and supervision to internal/update")
	}
	if strings.Contains(string(b), "InsecureSkipVerify") {
		t.Fatal("InsecureSkipVerify in launcher")
	}
}
