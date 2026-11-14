# WIRE-REP debug
- Cause: 4 manifest.test.ts failures = stale IMPLEMENTED set (implemented-ops.ts lacks getPortalDues, createPortalPaymentRequest, getPortalPaymentRequest). Not WIRE-REP code.
- Fix: none in implementation (none is right). Test-side: add the 3 ops to implemented-ops.ts. See WIRE-REP-dispute.md.
- WIRE-REP impl itself: manifest-ports 28/28, render/notification/reportingport suites pass.
