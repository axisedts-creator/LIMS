## C6-T30 debugger
- Verify log: static tests 12/12 pass; Playwright aborted before any test: `http://localhost:3200 is already used` (config has reuseExistingServer:false).
- Cause: environmental, not implementation. A stale `next dev -p 3200` (leftover from earlier debug runs) holds the port. No code change made.
- NOT verified: could not run netstat/kill (command approval denied in this session), so the PID is unidentified and Playwright was not re-run.
- Fix needed: free port 3200 (and 4126), then rerun `.orchestra/notes/C6-T30-verify.cmd`.

## Round 2 (2026-11-09, verify.log: 47/48, AC-11.1 "Send me a code" toHaveURL /code timeout)
- Cause: timing flake, not impl. Webserver is `next dev`; first server-action POST + redirect compiles `/r/[token]/code` cold, can exceed expect's 5s default. Isolated rerun: failed once (cold), then `--repeat-each=2` passed (11.3s cold, 4.8s warm). Action/redirect code (`actions.ts sendCode`) verified correct; all other tests via login() pass.
- No impl change (any warm-up hack in apps/portal would be test-driven). Fix belongs to tests/config (tester-owned): raise expect timeout / pre-warm /code, or run webServer on `next build && next start`. Not a spec dispute.
