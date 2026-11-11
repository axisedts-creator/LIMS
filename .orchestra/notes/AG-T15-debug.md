# AG-T15 debug
Cause: environment, not implementation. Verify ran under Git Bash; test helper `exec.Command("whoami")` resolved Git's whoami (prints `rauna`), System32's prints `raunak\rauna`. icacls prints `raunak\rauna`, so the audit sees an "unexpected" ACE and "no ACE for rauna" in 3 tests (TestIcaclsAuditMatchesTRD512, TestPrepareFoldersReplaces..., TestStatusFileACLAppliedNoUsers). The printed DACLs are correct (service account M, Administrators F, SYSTEM F, root protected, children inherited).
Fix: no code change (impl already correct; tests not editable). Re-run verify from cmd.exe/PowerShell, or with C:\Windows\System32 first on PATH. My re-run was blocked by a permission prompt, so NOT re-run by me.
## Round 2
Verify log (17:02) fails the same 3 icacls tests; cause unchanged: windows_integration_test.go:26 `exec.Command("whoami")` finds Git Bash whoami first; icacls prints the domain-qualified name. Impl cannot change icacls output, so no code change.
Fix is in the verify runner: run AG-T15-verify.cmd from cmd.exe/PowerShell (System32 first on PATH). My re-run was blocked by a permission prompt; NOT re-run by me.
## Round 3 (LD-108)
Re-run with C:\LIMS-state\shim first on PATH was blocked by a permission prompt; NOT re-run by me. No code or test changed.
Last log (verify.log) fails 3 tests at windows_integration_test.go:99/131/198, all PrepareFolders: "cannot make BUILTIN\Administrators the owner ... This security ID may not be assigned as the owner of this object." Not a whoami failure; the non-elevated token cannot assign Administrators as owner. Same as AG-T15-dispute.md (tests need elevation or skip). Awaiting the dispute ruling or an elevated verify run.
## Round 4 (after ruling, writer re-run)
Verify (non-elevated Git Bash): status ok, cli ok; svc: 3 PrepareFolders tests SKIP (ruling), TestPrepareFoldersOwnerIsAdministrators PASS (fails closed), one FAIL: windows_integration_test.go:234 `status.json readable by "raunak\rauna"` (TestStatusFileACLAppliedNoUsers).
`whoami` inside the test printed `rauna`: Git Bash prepends /usr/bin, so `which -a whoami` = /usr/bin/whoami, /bin/whoami, then /c/LIMS-state/shim/whoami. Shim is on PATH but not first. icacls prints `raunak\rauna`. Env-prefixed re-run with shim first was blocked by a permission prompt. No code or test changed (LD-108).
