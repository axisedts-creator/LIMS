Title: CR-C4-FD-T11-001: which permission gates FrontdeskPort.getPatientDemographics(purpose='notification') for a non-system (user) caller
From chunk: C4            To owner: C6 (+ lead) — C4 02-TRD §6.1 purpose table, 03-IC §4.3 case (15), CR-C6-015
Type: port
Blocking? no (FD-T11 implemented fail closed)
Problem: C4 02-TRD §6.1 lists purpose `notification` as "system only", but 03-IC §4.3 case (15) / CR-C6-015 needs a USER caller (consents + contactPresence only). No spec text names the permission such a user must hold. Today ([CONV], FrontdeskPort.impl.ts RULES.notification) a user needs `frontdesk.patient.read`; every other user is refused `auth.forbidden`.
Proposed change (exact): C6/lead name the permission for user callers of purpose `notification` (e.g. keep `frontdesk.patient.read`, or a C6 permission such as a notification-send permission from the permission catalogue), and update the C4 02-TRD §6.1 row from "system only" to "system, or user holding <permission>".
Backward compatible? yes (only widens or confirms a path that is gated today).
Tenant/security impact: PHI-adjacent (consents, presence of phone/email; no values returned to users). No RLS change, no new public surface.
IRD/regulatory impact: none.
Alternatives considered: system-only (breaks 03-IC case (15)); any authenticated staff user (too broad).
Tests that will prove it: FrontdeskPort contract case (15): user with the named permission gets consents + contactPresence; user without it -> auth.forbidden.
