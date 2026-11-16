Title: CR-C0-T0D-MSERIES-5: routes for the M1-entry footer links and the Patient or partner portal button
From chunk: C0-0D            To owner: lead (routes.yaml owner C0-0B; portal C6, partner C13)
Type: api
Blocking? no — T0D-MSERIES-5 ships the sign-in screen without these four elements (LD-250: a missing target is never stubbed).
Problem: board spec/program/design-m-series/M1-entry.png (sources/M1-entry.dc.html) shows four links on the staff sign-in screen whose targets are not in contracts/routes.yaml (checked 2026-11-16):
  - "Privacy policy"  — no privacy route on any origin.
  - "Terms of use"    — no terms route on any origin.
  - "Help and status" — no help or public status route (staff.lab.status_board /lab/status-board is a permissioned staff screen, not a public help page).
  - "Patient or partner portal" — no patient or partner web portal sign-in route (portal has only /r/{link_token} and /v/{qr_token}; partner has only record paths).
Proposed change (exact): lead decides whether each target exists and, if so, adds a routes.yaml row (id, origin, path, owner, auth: public). Once a row exists, C0-0D renders the link in apps/web/src/app/(auth)/layout.tsx (footer) or LoginForm (portal button, outlined pill under Continue). No name is invented here.
Backward compatible? yes (additive)
Tenant/security impact: public pages only; no PHI.
Alternatives considered: "#" or disabled links — rejected by LD-250.
Tests that will prove it: m5.entry.test.tsx LD-250 block (a rendered target must resolve in routes.yaml).
