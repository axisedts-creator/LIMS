# HC-T24 debug
- Verify fails before any test runs: "Flutter failed to delete file ...build\native_assets\windows\sqlcipher.dll" (reproduced on rerun).
- Not an implementation bug: no test executed, no HC-T24 code in the failing path. Likely the dll is locked by another process (stale flutter_tester/dart, AV, or another lane) or ACL issue.
- No code change made. Could not inspect processes (command approval denied). Needs: kill stale flutter_tester/dart procs or delete apps/phlebo_app/build, then rerun verify.
