# M series reference (design direction chosen by the founder, 2026-11-16)

Authority: `spec/program/13-M-SERIES.md`. These are references, not pixel specs: sample content is invented and a contrast gate wins over a board.

- `M0-foundations.png`  colours, gradients, status tones, type scale, components, shape and motion
- `M1-entry.png`        sign-in
- `M2-platform.png`     platform home (platform-staff shell)
- `M3-worklist.png`, `M3-worklist-catalog-open.png`  tenant staff shell (administrator view, 124 entries) and lab worklist
- `M4-patient.png`      patient app (first screen of 24; the full flow is in `sources/M4-patient.dc.html`)
- `M5-phlebotomist.png` phlebotomist app (first screen; full flow in `sources/M5-phlebotomist.dc.html`)
- `sources/*.dc.html`   board sources: read the `<style>` block and markup for exact values. They need a small template runtime to render and are not part of any build.
- `logos/`              Metro Labs square mark and landscape wordmark, light and white versions
