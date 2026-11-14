Title: CR-C0-0D-R04: active-centre list + switch for the staff top-bar centre switcher
From chunk: C0-0D (T0D-UI-R04)      To owner: C0-0C (contracts) / C2 (identity, session)
Type: api
Blocking? no (switcher ships read-only; T0D-UI-R04 rest is done)
Problem: 10-DESIGN-SYSTEM §3 "Centre/lab switcher in the top bar ... the active centre is always visible". The shell session (ShellSession / getShellSession) carries no centre list and no active centre, and no contract lets the web switch the active centre for the session. Without it the shell cannot show or change the centre (LD-140: no new data or endpoint without a CR).
Proposed change (exact): to be designed by the owner. Needed shape: (a) the session view the shell already reads gains `centres: { id: uuid; name: string }[]` and `active_centre_id: uuid | null` for the actor's membership; (b) an endpoint to set the active centre for the current session (body `{ centre_id }`, permission = membership of that centre, audited), after which the BFF refreshes the session. Shell side is ready: `<AppShell centres={{ options, activeId }}>` + `CentreSwitcher({ centres, activeId, onSelect })` (apps/web/src/core/shell).
Backward compatible? yes (additive fields / new endpoint)
Tenant/security impact: switching centre changes the centre-scoped data the actor sees; server must validate membership of the target centre and audit the switch; no new PHI.
Alternatives considered: reading another module's centre list from the shell (rejected: brief forbids reading other modules); client-only local switch (rejected: would show a centre the API does not apply).
Tests that will prove it: r04.shell.test.tsx CentreSwitcher cases (already passing standalone) + an AppShell test that onSelect calls the new endpoint via a server action and the active name updates.
