# T0D-BUILD-1 left (writer)
- user_pocket rows are NOT listed by listAccountSummaries: its party is an active core.memberships row OR a core.collection_centres row (accounts.repo PARTY_SQL), and
  memberships carry no name in the billing read; listing centres as pockets would duplicate every franchise. The kind filter user_pocket answers an empty 200.
  Gap: the data model names no party table / name for a user pocket. Needs a ruling (which table, which name) before it can be listed.
- laboratory rows = core.branches (name), limit 0, not blocked, same as findParty (not pinned by the tests).
- Page totals cover the rows of the current page only (contract has no tenant-wide total).
