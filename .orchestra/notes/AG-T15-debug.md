# AG-T15 debug
Cause: environment, not implementation. Verify ran under Git Bash; test helper `exec.Command("whoami")` resolved Git's whoami (prints `rauna`), System32's prints `raunak\rauna`. icacls prints `raunak\rauna`, so the audit sees an "unexpected" ACE and "no ACE for rauna" in 3 tests (TestIcaclsAuditMatchesTRD512, TestPrepareFoldersReplaces..., TestStatusFileACLAppliedNoUsers). The printed DACLs are correct (service account M, Administrators F, SYSTEM F, root protected, children inherited).
Fix: no code change (impl already correct; tests not editable). Re-run verify from cmd.exe/PowerShell, or with C:\Windows\System32 first on PATH. My re-run was blocked by a permission prompt, so NOT re-run by me.
## Round 2
Verify log (17:02) fails the same 3 icacls tests; cause unchanged: windows_integration_test.go:26 `exec.Command("whoami")` finds Git Bash whoami first; icacls prints the domain-qualified name. Impl cannot change icacls output, so no code change.
Fix is in the verify runner: run AG-T15-verify.cmd from cmd.exe/PowerShell (System32 first on PATH). My re-run was blocked by a permission prompt; NOT re-run by me.
