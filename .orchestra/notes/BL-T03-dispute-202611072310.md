# BL-T03 dispute (writer)
Test: `repo.static.test.ts:78` (`counters.repo.ts only ever sets last_no = last_no + 1`), regex `/\bSET\b[^`;]*?\blast_no\s*=\s*(?!last_no\s*\+\s*1\b)/is`.
Why wrong: `\s*` before the lookahead backtracks to zero width, so the lookahead then sees the space (" last_no + 1"), not `last_no`, and the negative assertion passes the match. Any canonical `SET last_no = last_no + 1` (space after `=`) is flagged; only the unspaced `last_no=last_no + 1` slips through. Line 77 (positive) and line 79 (+2..+9/$) are fine.
Proof: `counters.repo.ts` has exactly one SET, `last_no = last_no + 1`; bumpCounter unit tests (4) pass. Not worked around by reformatting SQL to dodge the regex.
Fix proposal: use a possessive-style guard, e.g. `/\blast_no\s*=(?!\s*last_no\s*\+\s*1\b)/i` applied to the SET clause.
Status: 1 test blocked on this; 41 others pass, live suite skipped (no DB).
