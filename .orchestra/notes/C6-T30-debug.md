## C6-T30 debugger
- Verify log: static tests 12/12 pass; Playwright aborted before any test: `http://localhost:3200 is already used` (config has reuseExistingServer:false).
- Cause: environmental, not implementation. A stale `next dev -p 3200` (leftover from earlier debug runs) holds the port. No code change made.
- NOT verified: could not run netstat/kill (command approval denied in this session), so the PID is unidentified and Playwright was not re-run.
- Fix needed: free port 3200 (and 4126), then rerun `.orchestra/notes/C6-T30-verify.cmd`.
