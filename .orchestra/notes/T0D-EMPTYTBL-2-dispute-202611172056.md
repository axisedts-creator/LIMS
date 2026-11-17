# T0D-EMPTYTBL-2 dispute (writer)
web-t34.components.test.tsx: 9 tests fail, same cause as T0D-EMPTYTBL-1 ruling #2 (PriceListsList "New price list").
`press` (line 108) = single `getByRole('button', { name })`. With `rules=[]` (`show([])`, line 1003) SurchargeRulesScreen and TaxScreen now render "New rule" twice: page header + empty message row, as done_when (1) and emptytbl2.catalog.test.tsx `expectCreateTwice` require. `getByRole` throws "multiple elements".
Failing: SCR-16 flat rule / percent rule / percent range / AC-14.5 overlap; SCR-17 rule form / lab default rule / Other tax type Select / AC-15.2; wording+safety guard (line ~1004).
Requested tester change: make `press` click the first match (page header button), e.g. `userEvent.click(within(root).getAllByRole('button', { name })[0]!)`. No other change; "New tax type" tests already use a populated or tab-switched screen.
Implementation stays. All other results in T0D-EMPTYTBL-2-impl.md.
