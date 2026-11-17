APPROVE

Scope: `git diff 886db34a..HEAD` = apps/web/src/features/billing/__tests__/copy-scan.mjs only (C4-owned per tools/lint/ownership.yaml; tools/lint/** is C0-0A, tester file only).

Checked:
- Banned list verbatim to PRD US-BL-16.1 / TRD c04-copy-scan ("IRD approved", "IRD-approved", "IRD certified", "approved by IRD", "commission", case-insensitive). Nothing added or invented.
- Whitespace-tolerant regexes (`\s` covers tab/newline/nbsp) matched over whole file; line number = newlines before match + 1 (correct for LF and CRLF).
- Job required: `c04-copy-scan` in .github/workflows/pr.yml:619 (command matches TRD 02 line 674) and .github/branch-protection.json:26.
- `node --test tools/lint/tests/copy-scan.test.mjs`: 52 pass, 0 fail. Real scan: `copy-scan: 99 files clean (11 billing pages, 17 components)`.
- No DB/RLS, routes, permissions, PHI or secrets touched.

Non-blocking note: PRD US-BL-16.1 says "message catalogs"; shared apps/web/src/core/i18n/messages.ts (not C4-owned) is outside the TRD-defined roots. Currently free of banned words. If the lead wants it scanned, raise a CR to C0 rather than widening roots here.
