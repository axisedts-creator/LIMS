TESTS_WRONG — web-t34.components.test.tsx:108 `press` uses single `getByRole('button', { name })`; on an empty list SurchargeRulesScreen and TaxScreen correctly render "New rule" twice. Implementation stays. Tester change:
1. Change `press` (line 108) to click the first match, the page header button: `userEvent.click(within(root).getAllByRole('button', { name })[0]!)`. This fixes all 9 failing tests (SCR-16 flat / percent / percent range / AC-14.5 overlap; SCR-17 rule form / lab default rule / Other tax type Select / AC-15.2; wording+safety guard). No other assertion changes.
Reasons:
- Brief done_when (1) (inbox T0D-EMPTYTBL-2, binding via LD-336 / LD-310 blanket authority) requires the create action in the page header AND repeated in the empty message row; two "New rule" buttons are the required output.
- spec/chunks/C3-catalog-pricing/03-APP-FLOW.md:367-368 fix only the empty text for SCR-16/SCR-17, not the number of create buttons; the empty texts stay asserted (test lines 690, 811-812).
- Same issue already ruled in .orchestra/notes/T0D-EMPTYTBL-1-ruling.md:3 (PriceListsList "New price list", fixed at web-t34:154 with `getAllByRole(...)[0]`); keep one pattern.
- No spec text contradicts the brief, so no CR.
