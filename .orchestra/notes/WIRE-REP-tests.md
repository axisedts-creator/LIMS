# WIRE-REP tests (tester)
- File: services/api/src/modules/reporting/__tests__/manifest-ports.test.ts (28 tests; 8 pass now as guards, 20 fail because manifest.ports and the renderer config keys do not exist yet).
- Covers: validateManifest, ports keys == 3, facade keys == ['renderPdf'], staging/dev/ci resolution, FAKE_PORTS still honoured, optional config keys, laziness (ghost token path, no fetch/socket at import), render_unavailable with no URL/path/token in the error (unset x3 + unreadable file), real createRenderPort via 127.0.0.1 stub + temp token file (bearer, mapping, actor guard, 503), planted-token log scan.
- Run: .orchestra/notes/WIRE-REP-verify.cmd (this file + manifest, render.port, notification.port, reportingport tests, via pnpm --dir services/api).
- The real call uses template analytics.report: it is the only schema present in contracts/render/; billing.* would hit a missing schema file.
- Assumptions (spec silent): token file read without trimming; invalid URL 'not a url' must throw naming LIMS_REPORTING_RENDERER_URL; unreadable token file: only "no leak" is asserted, code not pinned.
- Writer must re-run real-modules-boot.test.ts (ci): real now beats the fake there.
