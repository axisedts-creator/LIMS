# FD-T02 dispute (writer)
Two tests in `numbering.test.ts` contradict each other; no implementation can pass both.
- L17 golden `'yy zero-pads'`: `formatNumber('{yy}', { year: 2005, seq: 1 })` must return `'05'` (pattern has no `{seq:N}`).
- L45 `'throws on a pattern without {seq:N} (cannot be unique)'`: `formatNumber('{prefix}', { prefix: 'A', seq: 1 })` must throw.
Spec (03-IC §9.3, L2824) lists tokens only; it does not say a pattern must contain `{seq:N}` (that is a tester ruling).
Proposed fix (tester picks one): (a) change the L17 golden to e.g. `'{yy}{seq:1}'` with `{year:2005, seq:1}` -> `'051'` — keeps the uniqueness rule; or (b) drop the L45 rule.
Writer prefers (a): every §9.3 pattern has `{seq:N}`, and a pattern without it gives duplicate numbers.
State: the six domain files are written; 231/232 tests pass (only L17 fails). Not committed, pending ruling.
