# WIRE-REP impl (writer)
- Files: reporting/index.ts (manifest.ports = ReportingPort, NotificationPort, RenderPort; process.env), reporting/config.ts (additive: optional rendererUrl/rendererTokenFile + exported loadRendererConfig), reporting/ports/renderPort.lazy.ts (new).
- [CONV] Facade `renderPdf` is async, so unset/unreadable/invalid settings give a rejected LimsError('reporting.render_unavailable'); cause swallowed (no URL, path or token). Empty env value = unset.
- [CONV] Built port cached per url+tokenFile pair; an unset setting is never cached. Token file read at first call, trailing CR/LF stripped (spec silent; tests do not pin it).
- Run: manifest-ports 28/28, render/notification/reportingport tests, real-modules-boot (ci) 2/2 all pass; tsc clean for touched files.
- Round 2 (after ruling + tester fix of implemented-ops.ts): verify.cmd 7 files 148/148 pass; real-modules-boot 2/2 pass. No code change needed.
- Open: tsc reports contracts/ports/common.ts:36 TS2835 (not owned, not WIRE-REP); none in reporting files.
