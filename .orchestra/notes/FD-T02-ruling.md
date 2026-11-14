TESTS_WRONG — the L17 golden `'yy zero-pads'` asserts a `{seq:N}`-less pattern renders; the spec forbids such a pattern. L45 stays.
Change in `services/api/src/modules/frontdesk/domain/__tests__/numbering.test.ts` L17 only:
  `['yy zero-pads', '{yy}{seq:1}', { year: 2005, seq: 1 }, '051'],`
Keep L45 (`formatNumber('{prefix}', …)` throws) unchanged.
Reasons:
- spec/program/03-INTERFACE-CATALOG.md:2824 — "Every number is unique-indexed with `tenant_id` leading"; a pattern with no `{seq:N}` renders the same string for every allocation, so it can never satisfy that index.
- 03-INTERFACE-CATALOG.md:2828-2829 — `patient_code`/`registration_no` (C4-owned) "never reused"; impossible without a counter token.
- 03-INTERFACE-CATALOG.md:2828-2837 — every default pattern in the §9.3 table contains exactly one `{seq:N}`; `{seq:N}` is the only token that varies per allocation.
- spec/chunks/C4-frontdesk-billing/02-TRD.md:77 — C4 `numbering.ts` implements §9.3 tokens, so the §9.3 uniqueness rule binds it; the `{yy}` zero-pad behaviour is still tested by the corrected golden (2005 → `05`).
- No CR needed: the requirement is derivable (uniqueness), not missing or contradictory.
