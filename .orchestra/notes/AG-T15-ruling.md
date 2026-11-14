TESTS_WRONG — the "icacls tests need no elevation" premise is not in the spec; PrepareFolders only ever runs from the elevated installer.
Change in apps/bridge-agent/internal/svc/windows_integration_test.go (TESTER only):
1. TestIcaclsAuditMatchesTRD512, TestPrepareFoldersReplacesExistingBroadAndIsIdempotent, TestPrepareFoldersLinkDoesNotSkipLaterSiblings: first line `if !elevated() { t.Skip("PrepareFolders runs only from the elevated installer (04-UI-UX §2, 02-TRD §5.11)") }`; keep every assertion unchanged.
2. TestPrepareFoldersOwnerIsAdministrators: when !elevated(), PrepareFolders MUST return an error (t.Fatal if nil; fail-closed is the required behaviour); when elevated, keep the existing owner == BUILTIN\Administrators check on root and every child.
3. Replace header line 6 with: the PrepareFolders/icacls tests need an elevated shell; the AG-T15 verify run must be elevated to exercise them (otherwise they skip, not pass).
Reasons:
- 02-TRD.md:453 — ACLs are "set by installer with explicit DACL, inheritance disabled"; the installer is the actor, nothing says the DACL step works unelevated.
- 02-TRD.md:442 — "installed only by the elevated installer"; 04-UI-UX.md:24 — "All commands require an elevated prompt except `version`" (exit 3 not elevated). Install already refuses non-elevated (install.go:157) before PrepareFolders.
- Non-elevated Windows cannot assign BUILTIN\Administrators as owner (deny-only group in a filtered token, ERROR_INVALID_OWNER); a user-owned root keeps implicit WRITE_DAC, defeating 02-TRD.md:453 "no Users / Authenticated Users entries" in effect. So fail-closed is correct and the implementation stays.
- TestStatusFileACLAppliedNoUsers is not covered by this ruling: LD-108 (whoami PATH shim) governs it; re-run with C:\LIMS-state\shim first on PATH.
