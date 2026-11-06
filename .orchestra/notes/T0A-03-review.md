APPROVE

Round 2 review of `git diff 7f0bade..HEAD` (round-1 fixes in 7627b1c, 6e6bde8). Ran `node --test tools/lint/tests/*.test.mjs`: 163/163 pass (rules.test.mjs 128/128).
All three round-1 defects are fixed:
1. no-supabase-in-browser now covers apps/{web,portal,partner}. Bad fixtures added for portal and partner.
2. no-foreign-schema-sql flags `core.${…}` everywhere outside core/**, identity/repository included. Probes: `core.${t}` and `"core"."${t}"` in identity/repository are flagged; `core.membership_branches` there is not; `core.${t}` in core/** is not.
3. no-raw-bs-lib exempts only `bikram-sambat`, and only in *.test.*/*.spec.*/__tests__/. Probes: the converter is still flagged in a test file, and bikram-sambat is still flagged in a non-test app file.
Only owned paths changed, with no secrets or PHI. The rule names match the 06 row T0A-03 exactly. Each rule has bad and good fixtures, and AB-21 / AC-0A-3.4 are covered.
Known limits (non-blocking, already in impl notes): the hand lexer can misread regex literals or JSX text that contain quotes. CLI and CI wiring is deferred to T0A-10.
