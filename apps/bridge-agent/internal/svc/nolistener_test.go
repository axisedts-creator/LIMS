package svc_test

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// done_when: "no listener by default" / REQ-SEC-114. The service, status and CLI packages open no listening socket at all: a listener is a
// per-instrument tcp_server concern (AG-T09), never part of the Windows service, status file or CLI. The [manual] port scan
// (netstat -ano | findstr LISTENING, see AG-T15-tests.md) proves the running service; this test proves the code cannot.
func TestNoListenerInSvcStatusCLIPackages(t *testing.T) {
	forbiddenSel := map[string]bool{"Listen": true, "ListenTCP": true, "ListenUDP": true, "ListenPacket": true, "ListenIP": true, "ListenUnix": true,
		"ListenAndServe": true, "ListenAndServeTLS": true, "Serve": true, "ServeTLS": true, "NewServer": true}
	forbiddenImport := map[string]bool{"net/http/pprof": true, "expvar": true, "net/rpc": true}
	for _, dir := range []string{".", "../status", "../cli"} {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		var src []string
		for _, f := range files {
			if !strings.HasSuffix(f, "_test.go") {
				src = append(src, f)
			}
		}
		if len(src) == 0 {
			t.Errorf("%s has no non-test Go file yet (package not implemented)", dir)
			continue
		}
		fset := token.NewFileSet()
		for _, f := range src {
			raw, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			file, err := parser.ParseFile(fset, f, raw, 0)
			if err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			for _, im := range file.Imports {
				if p := strings.Trim(im.Path.Value, `"`); forbiddenImport[p] {
					t.Errorf("%s imports %s", f, p)
				}
			}
			ast.Inspect(file, func(n ast.Node) bool {
				if se, ok := n.(*ast.SelectorExpr); ok && forbiddenSel[se.Sel.Name] {
					if id, ok := se.X.(*ast.Ident); ok && (id.Name == "net" || id.Name == "http" || id.Name == "tls") {
						t.Errorf("%s: %s.%s opens or prepares a listener", fset.Position(se.Pos()), id.Name, se.Sel.Name)
					}
				}
				return true
			})
		}
	}
}
