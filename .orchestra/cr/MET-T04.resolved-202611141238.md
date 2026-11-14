Title: CR-C7-0xx: host query service must pass an empty barcode list to the driver so modes (b)/(c) get a QCK NF
From chunk: C7            To owner: C7 (service/hostQuery.service.ts, outside the MET-T04 file list)
Type: bug
Blocking? yes: MET-T04 e2e "QRY sample-range answered NF" and "archive" (2 tests in simulator-agent-api-metis.e2e.test.ts)
Problem: D-MET-1 (LD-163) answers sample-number-range and time-range queries NF (reason unsupported_query_mode). The Metis driver returns [] from extractHostQueryBarcodes for those modes and buildHostQueryReply([]) builds the QCK NF. service/hostQuery.service.ts parseQuery (line ~83) treats barcodes.length < 1 as malformed, so no reply is written and the analyser times out. Same gap as MET-T03 impl "Open".
Proposed change (exact): in parseQuery allow barcodes.length === 0 (keep the upper bound and the per-barcode checks); with [] skip the lab lookup and call driver.buildHostQueryReply(parsed, []) as for any answered query; keep the status/capability gates so a non-verified driver still stays inert. H80E returns >= 1 barcode or malformed, so it is unchanged.
Backward compatible? yes (H80E and generic drivers never return []).
Tenant/security impact: none; no new field, no PHI.
Alternatives considered: driver throws message_malformed for modes (b)/(c): rejected, the addendum wants an NF answer.
Tests that will prove it: the two failing MET-T04 e2e tests; hostQuery.service.test.ts must stay green.
