APPROVE
Round 3 (4a57495..HEAD). All round-2 findings resolved:
1. E20 View log: server/getAgentLogBundle.server.ts (`server-only`, bad UUID → 404 `common.not_found`), path/fields match contracts/openapi/instruments.yaml:1998 (bundle_id, lines, from_at_agent, to_at_agent, created_at); button only for manage + completed `upload_logs` + `log_bundle_id`; Drawer width="lg" + CodeBlock (kit props verified). MSW tests cover call path, lines, and absence cases incl. READ.
2. Alt+E registered on `staff.instruments.agent` (route id exists in core/nav/generated.ts:125) inside manage-only IssueEnrolmentCode, opens confirm only, unregisters on unmount; tested.
3. Alt+N removed from help; CR-C7-WEB-T02-d filed in .orchestra/cr/WEB-T02.nonblocking.md.
Verify: vitest.web-t02 config 73/73 pass. Only owned paths changed. No secrets/PHI in logs/URL. Nit (non-blocking): actions.ts:14 missing space after `AgentLogBundle,`.
