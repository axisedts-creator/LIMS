# T-Q4 impl (writer) — LD-138 reset
- Files: app/(staff)/engagement/queue/{page,loading,error}.tsx, setup/{page,loading,error}.tsx, tokens/route.ts (5 s poll BFF); features/engagement/components/{QueueConsole,QueueSetup,QueueHosts}.tsx, queue-model.ts; server/{queue.server,queue-actions,queue-pages}.ts(x).
- [CONV] Call next = `Alt+C`: W6 says Alt+N, but Alt+N is a global key and registry.register() throws (AC-0D-7.5). Needs lead/CR to confirm the key (tester flagged the same conflict).
- [CONV] Kit TextField requires maxLength; W7 limits are validated in queue-model with messages, input cap 255 (a tight maxLength would silently cut over-long input).
- [CONV] Pair: server action → Q8 → T-Q5 setDisplayCookie → redirect('/queue-display'); the client never sees the secret. Actions return {ok,code}; QueueHosts rethrows as Error.problem.
- OPEN: `@lims/ui/components/TokenSlip` is not in the kit yet (CR-C16-016). Vitest aliases a stub, so tests pass, but `tsc` fails with TS2307 on QueueConsole.tsx:11 until C0 ships it (not editable by C16).
- OPEN: new BFF route `queue/tokens/route.ts` is not in contracts/routes.yaml (route handler, not a nav page); confirm it is allowed or tell me where polling should live.
- OPEN: centre comes from `?centre_id=` or the first /v1/identity/centres entry (session has no centre); labName = session tenantCode (no tenant display name in the session). Server code (queue.server/actions/route) has no unit tests — only source checks.
