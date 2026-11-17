TESTS_WRONG — the test asserts something the spec does not require (say precisely what to change in the test)
- Spec requires only that the counter advances by exactly old + 1: spec/chunks/C4-frontdesk-billing/05-SCHEMA.md:593,598 (`NEW.last_no = OLD.last_no OR NEW.last_no = OLD.last_no + 1`).
- Implementation complies: services/api/src/modules/billing/repository/counters.repo.ts:7 `SET last_no = last_no + 1`.
- Defect in repo.static.test.ts:78: `\s*` before the negative lookahead backtracks to zero width, so the lookahead sees " last_no + 1" and passes. Verified with node: the regex matches `SET last_no = last_no + 1, updated_at = now()` (true), so it rejects the spec-compliant form.
- Change line 78 to: `expect(s).not.toMatch(/\bSET\b[^`;]*?\blast_no\s*=(?!\s*last_no\s*\+\s*1\b)/is);`
  (Verified: false on the canonical SET, true on `SET last_no = 5`.) Keep the intent (no other assignment to last_no); lines 77 and 79 stay as they are.
- Implementation must NOT be reformatted to dodge the regex.
