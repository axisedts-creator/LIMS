# RS-C6 impl (LD-140, LD-170)
- apps/portal/src/app/portal.css: token vars only (no fallback hex), card radius-lg on neutral-0, buttons radius-full, alerts/notices radius-md.
- components/ReportDetailView.tsx: "Report preview" region (`<object type=application/pdf data=pdfHref(newest downloadable)>` + download link fallback, on neutral.100 via new report-preview.css); delivery counts as `Chip` list (zero counts omitted). [CONV] object not iframe: axe frame probe fails in jsdom.
- components/DeliveryDetail.tsx: attempt outcome is a `Chip`. New components/report-preview.css (kit tokens only).
- Snapshots recorded: __tests__/__snapshots__/rs-c6.*.snap (7).
- Run (after ruling; tester fixed test, no impl change): RS-C6-verify.cmd 59/59 pass; vitest.c6-t31.config.ts 200/200 pass.
- Not done (no data, needs CR): template switcher, per-channel last-sent status.
