# RS-C6 impl (LD-140, LD-170)
- apps/portal/src/app/portal.css: token vars only (no fallback hex), card radius-lg on neutral-0, buttons radius-full, alerts/notices radius-md.
- components/ReportDetailView.tsx: "Report preview" region (`<object type=application/pdf data=pdfHref(newest downloadable)>` + download link fallback, on neutral.100 via new report-preview.css); delivery counts as `Chip` list (zero counts omitted). [CONV] object not iframe: axe frame probe fails in jsdom.
- components/DeliveryDetail.tsx: attempt outcome is a `Chip`. New components/report-preview.css (kit tokens only).
- Snapshots recorded: __tests__/__snapshots__/rs-c6.*.snap (7).
- Run: 58/59 pass. Open: keyboard-only test unreachable, see RS-C6-dispute.md.
- Not done (no data, needs CR): template switcher, per-channel last-sent status.
