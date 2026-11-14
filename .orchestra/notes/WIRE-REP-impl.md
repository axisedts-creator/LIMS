# WIRE-REP impl (writer)
- Files: reporting/index.ts (manifest.ports = ReportingPort, NotificationPort, RenderPort; process.env), reporting/config.ts (additive: optional rendererUrl/rendererTokenFile + exported loadRendererConfig), reporting/ports/renderPort.lazy.ts (new).
- [CONV] Facade `renderPdf` is async, so unset/unreadable/invalid settings give a rejected LimsError('reporting.render_unavailable'); cause swallowed (no URL, path or token). Empty env value = unset.
- [CONV] Built port cached per url+tokenFile pair; an unset setting is never cached. Token file read at first call, trailing CR/LF stripped (spec silent; tests do not pin it).
- Run: manifest-ports 28/28, render/notification/reportingport tests, real-modules-boot (ci) 2/2 all pass; tsc clean for touched files.
- Open: manifest.test.ts "501 stubs in dev" 4 tests (getPortalDues, createPortalPaymentRequest, getPortalPaymentRequest, no-echo) fail with auth.unauthenticated; those ops are now implemented in portal.handlers.ts, so the tests are stale and unrelated to WIRE-REP. Tester to fix.
