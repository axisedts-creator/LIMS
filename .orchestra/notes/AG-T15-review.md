APPROVE

Scope: `39636b13..HEAD` = test-only change in apps/bridge-agent/internal/svc/windows_integration_test.go plus orchestra notes (ruling, debug, impl, tests, CR rename). Owned paths only.

Ruling compliance (AG-T15-ruling.md): items 1-3 applied verbatim. The three PrepareFolders/icacls tests skip first when not elevated; every assertion is unchanged. TestPrepareFoldersOwnerIsAdministrators now requires fail-closed when not elevated and checks the Administrators owner on the root and every child when elevated. The header line is replaced. The test was not weakened: the owner test is stricter than before, since it no longer accepts any error from an elevated run.
Prior review items: 1 (owner) is fixed at platform_windows.go:127/134/142, failing closed when not elevated. 2 (SkipDir) is fixed at platform_windows.go:241, which returns nil. 3 is filed as .orchestra/cr/AG-T15.nonblocking.md (non-blocking for the default install: no listener and no rule by default).
No names invented, no PHI or secrets in the diff, and no RLS, permission, tier or idempotency surface in this task.

Verify (my run, non-elevated Git Bash): status ok, cli ok. In svc, 3 tests SKIP (ruling), the SCM test SKIP (opt-in) and the owner test PASS. TestStatusFileACLAppliedNoUsers FAILs at windows_integration_test.go:234 `status.json readable by "raunak\\rauna"`: the test's whoami resolves to Git's (`rauna`), while icacls prints `raunak\rauna`. That is the LD-108 environment issue, not a code defect. The DACL holds only that user, Administrators and SYSTEM. A run with the shim first on PATH was blocked by a permission prompt.
Gate before merge: run AG-T15-verify.cmd from an ELEVATED cmd/PowerShell with C:\LIMS-state\shim first on PATH. Without elevation the icacls audit (done_when "icacls audit matches 02-TRD 5.12") is skipped, not proven.
Not run: elevated icacls tests, opt-in SCM test, Win11 install/uninstall, Win10 (release gate, LD-94), [manual] netstat port scan.
