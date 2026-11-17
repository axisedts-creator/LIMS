package update_test

// Static guards for REQ-SEC-114/119: the update path opens no listener and never weakens TLS. These read the shipped (non-test)
// sources of internal/update and cmd/launcher; they fail while those packages do not exist.
import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNoListenerNoInsecureTLSInUpdateAndLauncher(t *testing.T) {
	for _, dir := range []string{".", filepath.Join("..", "..", "cmd", "launcher")} {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		n := 0
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			n++
			src, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			af, err := parser.ParseFile(token.NewFileSet(), f, src, 0)
			if err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			ast.Inspect(af, func(nd ast.Node) bool {
				switch x := nd.(type) {
				case *ast.SelectorExpr:
					if id, ok := x.X.(*ast.Ident); ok && (id.Name == "net" || id.Name == "http") &&
						(x.Sel.Name == "Listen" || x.Sel.Name == "ListenAndServe" || x.Sel.Name == "ListenAndServeTLS" || x.Sel.Name == "Serve") {
						t.Errorf("%s: %s.%s: the update path must not open a listener (REQ-SEC-114)", f, id.Name, x.Sel.Name)
					}
				case *ast.Ident:
					if x.Name == "InsecureSkipVerify" {
						t.Errorf("%s: InsecureSkipVerify: TLS verification must never be bypassed", f)
					}
				}
				return true
			})
		}
		if n == 0 {
			t.Errorf("%s has no non-test Go files (AG-T16 not implemented)", dir)
		}
	}
}

// 02-TRD 5.11: the Authenticode check may be skipped only in builds tagged nonprod; the Ed25519 check never. So no shipped file
// may carry a bare "skip authenticode" switch: any such code must live in a file constrained by the nonprod tag.
func TestAuthenticodeSkipOnlyBehindNonprodTag(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		b, _ := os.ReadFile(f)
		s := strings.ToLower(string(b))
		if (strings.Contains(s, "skipauthenticode") || strings.Contains(s, "skip_authenticode") || strings.Contains(s, "noauthenticode")) &&
			!strings.Contains(string(b), "//go:build nonprod") {
			t.Errorf("%s: an Authenticode bypass must be confined to a file with //go:build nonprod (02-TRD 5.11, CR-C7-013)", f)
		}
	}
}
