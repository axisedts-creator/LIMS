# WEB-T02 debug
- 2 fails, both test defects; impl matches spec. No impl change made.
- (1) "manage actions are enabled": fixture has `live` instrument, spec 04-UI-UX.md:115 says Retire disabled until instruments retired. Impl AgentActions.tsx:66-72 correct.
- (2) columnheader /State/i matches "State" and "Link state" (both required, 04-UI-UX §3 line 106). Unsatisfiable by any impl.
- Dispute already in WEB-T02-dispute.md with test fixes (anchor regex; Retire enabled with instruments=[]). Stopped per rule.
