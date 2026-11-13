Title: CR-C16-T-Q4-a: W6 [Call next] page shortcut Alt+N contradicts C0 global Alt+N
From chunk: C16           To owner: spec owner of C16 04-UI-UX W6 / C0-0D (shell shortcuts)
Type: spec
Blocking? no — [Call next] stays reachable by its button; code uses `Alt+C` as a cited stopgap (apps/web/src/features/engagement/components/QueueConsole.tsx, shortcut register) until ruled. Same root as CR-C7-WEB-T03-a (.orchestra/cr/WEB-T03.resolved-202611091015.md).
Problem: spec/chunks/C16-patient-engagement/04-UI-UX.md:227 declares W6 [Call next] `Alt+N`, and :231 says "`Alt+N` with an empty queue → toast". spec/chunks/C0-foundation-contracts/04-UI-UX.md:317 reserves global `Alt+N` (focus navigation), and AC-0D-7.5 requires the registry to throw on a page key that conflicts with a global key. No implementation can satisfy both.
Proposed change (exact): in C16 04-UI-UX W6 change [Call next] `Alt+N` to `Alt+C` (free on page `staff.engagement.queue`; not used by R/S/D/K/T/I or any global key) at :227, and change :231 to "[Call next] (`Alt+C`) with an empty queue → toast "No one is waiting."".
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: t-q4.source.test.ts / t-q4.console.test.tsx shortcut tests (currently key-agnostic: "call next" shortcut whose key is not global) may then pin the ruled key.
