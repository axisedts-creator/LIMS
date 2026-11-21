APPROVE

Reviewed 454924401..HEAD (tester fc6351626, writer ab2c826a1).
- Rule 2: ManifestInbox, PenaltyEvents, TicketInbox now render the kit FilterBar (children + onReset, props that already exist, LD-441); PartysetCommon was already on FilterBar. Same controls, same URL handlers. ManifestInbox reset keeps its label through the default resetLabel 'Reset filters'.
- Rule 7: SalesRepresentatives tree uses ARIA roles on div (tree/group/treeitem, keys and focus logic unchanged); the indent the raw ul gave by default is kept by the token-only shell.css `.lims-tree-group` rule. TicketThread puts the raw h2 into Card title and the raw ol into role=list on the existing kit `.lims-timeline` classes.
- Registry: tester removed the PARTNERS entries (LD-441); writer removed both PARTNERS sections from the mirror notes; nothing re-added. tokens.json and kit.css not touched.
- Display only: no route, permission, contract, operation, API or log change; no secrets or PHI; paths are all in scope.
- Re-ran: uiguard1 36/36, uiguard1-partners 25/25, partyset1 165, sales1 102, t16 120, msgdesk1 134, all green.
- Not verified: pixel match against the Worklist mock (no browser).
