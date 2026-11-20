# T0D-MSGDESK-1 debugger (2026-11-20)
- Verify log: only 4 fail, all in core/nav: nav-complete.admin-pack (3: corp_admin sees lab.approval / lab.result.approve; hidden list stale) and nav-complete.build (billing count 22 vs pinned 9).
- Cause: not this task. MSGDESK adds only engagement.msg_templates, engagement.msg_broadcasts, partners.tickets (permission engagement.broadcast.read / partners.ticket.read); none touches lab, billing or the corp_admin hidden list. Billing grew to 22 on main via T0D-FINCTRL-1 / T0D-MISREPORTS-1; admin-pack pins are stale on main (ruling line 9 already says so).
- Fix: none in implementation; changing code to satisfy these would hide lab.approval or drop billing entries (wrong). Tests may not be edited by me. Needs its own task (re-pin admin-pack hidden list and billing count).

## Round 2 (2026-11-20)
- Re-read verify log: same 4 failures, all core/nav (admin-pack x3, build billing count 22 vs 9). Branch diff vs main touches only engagement/partners manifests; no lab, billing or core/nav file. Failures exist on main; no implementation fix possible without hiding lab.approval or dropping billing entries.
- No code change. Dispute written: .orchestra/notes/T0D-MSGDESK-1-dispute-core-nav.md.

## Round 3 (2026-11-20)
- Same 4 failures (core/nav admin-pack x3, build billing 22 vs 9). Branch diff vs main touches only core/i18n/messages.ts in apps/web/src/core; no nav, lab or billing file.
- Cause is stale pins on main, not MSGDESK. No code change. Dispute stands: .orchestra/notes/T0D-MSGDESK-1-dispute-core-nav.md (re-pin in own task or drop vitest.nav-complete.config.ts from verify.cmd).

## Round 4 (2026-11-20)
- Verify log: 2 fail, both nav-complete.admin-pack (corp_admin holds lab.result.approve; lab.approval visible). Billing and hidden-list pins now pass after the LD-435 tester edits.
- Cause: services/api/src/modules/identity/role-packs/role-packs.data.yaml corp_admin (line 125) holds lab.result.approve; spec/program/11-ROLE-MATRIX.data.yaml corp_admin does not (R5, R5a). API pack drifted from spec on main; branch diff touches no identity or nav file.
- No code change: the fix is editing the identity role pack (not MSGDESK-owned, changes tenant permissions). Dispute updated: T0D-MSGDESK-1-dispute-core-nav.md.
