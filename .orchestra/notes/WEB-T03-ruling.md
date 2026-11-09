TESTS_WRONG — round 2, dispute item 1 (test:115 `^Vendor$` columnheader): the spec names the column "Vendor/Model", so an exact `^Vendor$` asserts a header the spec does not have.
- C7 04-UI-UX.md:122 lists the columns as "Code (link) · Name · Vendor/Model · Protocol · …". There is no column called "Vendor".
- Round-1 item 1 added the anchor only so that `State` would not match both "State chip" and "Link state" (04-UI-UX.md:122). Anchoring every header goes further than that ruling did.
- Fix in web-t03.components.test.tsx:115: change the list entry 'Vendor' to the regex `/^Vendor\s*\/\s*Model$/i`. This accepts both "Vendor/Model" and "Vendor / Model". Keep the `^…$` anchor on the other headers.
- Same cause, same line: the spec calls the last column "Unmapped codes" (04-UI-UX.md:122), so `^Unmapped$` is also stricter than the spec. Use `/^Unmapped( codes)?$/i`.
- The implementation needs no change for this item.

---
Round-1 ruling (kept because LD-79 cites it; item 3 was decided by LD-79 = Alt+I):
CR_NEEDED — dispute item 3 (Alt+N) is a spec contradiction (CR in .orchestra/cr/WEB-T03.md); items 1, 2, 4, 5, 6, 7 are TESTS_WRONG, fix the tests as below.
3. Alt+N (test:167-180): C7 04-UI-UX.md:192 requires SCR-05 Alt+N, but C0 04-UI-UX.md:317 reserves global Alt+N and C0 04-UI-UX.md:325 / C0 01-PRD.md:245 (AC-0D-7.5) forbid page keys that clash with global keys. Leave the test unchanged until the CR decides the key (same as CR-C7-WEB-T02-d).
1. Columns (test:114): C7 04-UI-UX.md:122 lists both "State chip" and "Link state", so `/State/i` matches two headers. Anchor it: `new RegExp(`^${h}$`, 'i')`, as already ruled in WEB-T02-ruling.md item 2.
2. "3 unmapped" (test:133): rows 1, 4 and 5 inherit `unmapped_code_count: 3` (test:59, 106-107), so `getByRole` always finds several. Give rows 4 and 5 distinct counts (for example 0), or use `getAllByRole(...)[0]`. Keep the href and "12 unmapped" checks (04-UI-UX.md:122).
4. `/^agent/i`, `/^driver/i` buttons (test:214, 222, 310, 389): the spec does not set the order of the accessible name, and the kit Select names its button "<value> <label>". Drop the `^` anchor (`/agent/i`, `/driver/i`), scoped so it does not also match other controls.
5. `/^host/i` (test:293, 356): 04-UI-UX.md:130 requires "Host" and :134 requires "Host query", so the regex matches both. Use `/^host$/i`.
7. AC-03.3 422 override (test:443): the handler never calls `rec(request)`, so `calls` stays empty and the waitFor at :447 can never pass. Make it `async ({ request }) => { await rec(request); return problem(...) }`.
6. 301-character paste (test:787-798): 04-UI-UX.md:113/:143 only require a reason of 3–300 characters. A maxLength=300 textarea truncates the paste to a valid 300 characters, so a request is correct. Remove `expect(calls).toHaveLength(0)` and keep the `<= 300` body check, plus a check that `reason.value.length <= 300`.
