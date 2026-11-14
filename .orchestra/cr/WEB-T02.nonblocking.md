Title: CR-C7-WEB-T02-a: apps/web test devDependencies for C7 web component tests
From chunk: C7            To owner: C0-0D
Type: shared-lib
Blocking? no (tests run with the store packages already installed; a clean install of apps/web would lose them) — task WEB-T02 (and WEB-T03..T06)
Problem: WEB-T02 tests (component + MSW, axe — 06-IMPLEMENTATION-PLAN row WEB-T02) import vitest, msw, jsdom, axe-core, @testing-library/react, @testing-library/user-event. 01-CHUNK-MAP §3: apps/web dependencies are added by C0-0D on a CR.
Proposed change (exact): apps/web/package.json devDependencies + pnpm-lock: "@testing-library/react": "16.3.3", "@testing-library/user-event": "14.6.8", "axe-core": "4.14.0", "jsdom": "31.0.0", "msw": "3.0.3", "vitest": "5.1.0" (same pins as already in the pnpm store / other workspaces). C7 02-TRD dependency rows to list them via this CR.
Backward compatible? yes (dev only)
Tenant/security impact: none (devDependencies, not bundled)
Alternatives considered: running tests from packages/ui's devDeps — breaks module resolution for apps/web `@/` imports.
Tests that will prove it: `.orchestra\notes\WEB-T02-verify.cmd` after `pnpm install --frozen-lockfile`.

---

Title: CR-C7-WEB-T02-b: centres in scope + working centre for apps/web server components
From chunk: C7            To owner: C0-0D (web shell session) — data from C0 identity `listCentres`
Type: shared-lib
Blocking? no — SCR-01 New agent dialog shows a "Choose a centre." field error and never calls E11 until centres are provided (review WEB-T02 #3); FilterBar Centre has no options.
Problem: 04-UI-UX SCR-01 needs "Centre (select, centres in scope)" and New agent default "working centre". apps/web/src/core/session exposes no centre scope / working centre; identity `listCentres` needs `identity.centre.read`, which a lab manager may lack, and is not scoped to the actor.
Proposed change (exact): add to `ShellSession.actor` (apps/web/src/core/session/types.ts) `centres: { id: string; name: string; kind: 'own' | 'franchise' | 'home_collection'; isActive: boolean }[]` (actor's scope) and `workingCentreId?: string`, filled by getShellSession(). C7 then passes them to AgentsList (filters kind own/franchise + active for the dialog).
Backward compatible? yes (additive)
Tenant/security impact: none new (actor's own scope only)
Tests that will prove it: WEB-T02 page test passing `centres`/`workingCentreId` from the session mock.

---

Title: CR-C7-WEB-T02-c: InstrumentSummary lacks last_link_error_code / silent_since
From chunk: C7            To owner: C7 contracts (instruments.yaml) via C0-0B
Type: api
Blocking? no — SCR-02 Instruments tab renders "—" / "Not silent" until present.
Problem: 04-UI-UX SCR-02 Instruments tab: "last error code, silence status" (AC-16.3). E21 returns InstrumentSummary (additionalProperties: false) without them; only Instrument.status has `last_link_error_code`, `silent_since` (02-TRD §7.4).
Proposed change (exact): add optional `last_link_error_code: string maxLength 64` and `silent_since: IsoUtc` to `components.schemas.InstrumentSummary` (same source columns as Instrument.status).
Backward compatible? yes (additive optional fields)
Tenant/security impact: none (no PHI)
Tests that will prove it: contract test on E21 response; WEB-T02 Instruments-tab test.

---

Title: CR-C7-WEB-T02-d: SCR-01 / SCR-05 page shortcut Alt+N clashes with global Alt+N
From chunk: C7            To owner: C0-0D (shell shortcuts) / spec owner of C7 04-UI-UX §4
Type: spec
Blocking? no — SCR-01 New agent stays reachable by its button; help no longer lists Alt+N.
Problem: C7 04-UI-UX.md:190 (SCR-01 `Alt+N` New agent) and :192 (SCR-05 `Alt+N` New instrument) collide with GLOBAL_KEYS `Alt+N` in apps/web/src/core/shortcuts/registry.ts:3; `shortcuts.register` throws on a global-key clash (AC-0D-7.5).
Proposed change (exact): spec owner assigns SCR-01 and SCR-05 a free page key in C7 04-UI-UX §4, or rules that page "New" actions reuse the global Alt+N handler.
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: WEB-T02 shortcuts test registering the ruled key on the SCR-01 page.
