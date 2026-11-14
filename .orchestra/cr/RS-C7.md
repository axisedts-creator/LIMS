Title: CR-C7-RS01: add agent last heartbeat and queue depth to InstrumentSummary (E23) for SCR-05 cards
From chunk: C7 (task RS-C7)            To owner: C7 (02-TRD E23 read model) + C0-0C (contracts/OpenAPI)
Type: api
Blocking? no — RS-C7 ships with the card showing "Last message" (`InstrumentSummary.last_message_at?`) in that slot until this CR is ruled (LD-140: "raise a CR, do not invent").
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  RS-C7 done_when and spec/program/10-DESIGN-SYSTEM.md:107 ask for instrument link cards with "state dot + word, last heartbeat, queue depth".
  InstrumentSummary (02-TRD.md:739) has no heartbeat or queue field; those live only on AgentSummary.health (02-TRD.md:734, E10) and agent_status (05-SCHEMA.md:652-653).
  The SCR-05 list calls only E23 `listInstruments`; a restyle may not add API calls (LD-140), so the cards cannot show them.
Proposed change (exact): OpenAPI, InstrumentSummary (E23 items), two new optional read-only fields taken from the instrument's agent row in agent_status:
  agent_last_heartbeat_at?: string (date-time, nullable)   -- agent_status.last_heartbeat_at
  agent_queue_depth?: integer (>= 0)                       -- agent_status.queue_depth
  Alternative shape (owner's choice): `agent_health?: { state, last_heartbeat_at?, queue_depth }` reusing AgentSummary.health field names.
  No DDL change; the E23 query joins agent_status by agent_id (same tenant, RLS unchanged).
Backward compatible? yes — additive optional response fields; existing consumers ignore them.
Tenant/security impact: no RLS change; no PHI (operational telemetry already shown to holders of `instruments.agent.read` on E10). Owner to confirm that `instruments.instrument.read` holders may see agent heartbeat/queue; if not, return the fields only when the caller also has `instruments.agent.read`.
IRD/regulatory impact: none (not billing).
Alternatives considered:
  1. SCR-05 also calls E10 `listAgents` and joins by agent_id in the client — rejected for RS-C7: a restyle may not add API calls (LD-140); possible later as a non-restyle task.
  2. Show "Last message" instead (current RS-C7 implementation) — kept as the interim.
Tests that will prove it:
  - contract test: E23 response items validate with the new optional fields; value equals agent_status of the instrument's agent.
  - RLS test: tenant B agent_status never appears in tenant A's E23 response.
  - web: SCR-05 card shows heartbeat <time> and queue depth when present, falls back to last message when absent.
