APPROVE

Scope: 0a25da56..HEAD = tester edit of reporting/__tests__/implemented-ops.ts (adds getPortalDues, createPortalPaymentRequest, getPortalPaymentRequest per arbiter ruling) + notes. Also re-checked the WIRE-REP code from 0c5151e7 (index.ts ports, config.ts loadRendererConfig, ports/renderPort.lazy.ts).
- Ruling applied verbatim; manifest.test.ts unchanged; excluded count still asserted equal to IMPLEMENTED.size, so not a weakening.
- manifest.ports = exactly ReportingPort, NotificationPort, RenderPort; facade = renderPdf only; nothing read/built at import; unset/unreadable gives LimsError('reporting.render_unavailable') with the cause swallowed; config error names the key, never the value. LD-186 is cited. Only the authorised files were touched.
- No migration/RLS/route/permission surface in this task. No PHI, no secrets.
- Ran: vitest manifest-ports.test.ts + manifest.test.ts: 2 files, 40/40 pass.
- Not re-run by reviewer: render/notification/reportingport suites and real-modules-boot (writer reports 148/148 and 2/2). Open, not WIRE-REP: tsc TS2835 at contracts/ports/common.ts:36.
