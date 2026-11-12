Title: CR-C16-0xx: contracts/routes.yaml missing staff_web rows already in IC section 7 (LD-112, LD-130)
From chunk: C16            To owner: C0
Type: bug (transcription lag)
Blocking? yes (@lims/web build:nav fails -> build and typecheck fail)
Problem: build-nav reports routeId not found in contracts/routes.yaml for staff.platform.{home,tenants,ird,support_sessions,dead_letters,staff,auth_events} and staff.smartreport.{summaries,library,wording}. spec/program/03-INTERFACE-CATALOG.md s7 defines them (e.g. lines 2335, 2357).
Proposed change (exact): transcribe the IC s7 staff_web rows into contracts/routes.yaml verbatim (also the 8 staff.quality rows from LD-130 if absent).
Backward compatible? yes
Tenant/security impact: none
Tests that will prove it: `pnpm --filter @lims/web run build:nav` exits 0.
