# Renderer decisions — Spike C6-T05: repeated page header / footer

- Date run: 2026-11-07 · Plan row: `spec/chunks/C6-reporting-delivery/06-IMPLEMENTATION-PLAN.md` C6-T05 · 02-TRD §5.1 "Spike C6-T05", AC-03.2, AC-03.5
- Pinned: Playwright 1.65.0 (`playwright` npm), Playwright-managed Chromium 158.0.8127.18 (PDF producer `Skia/PDF m158`)
- **Technique: thead-tfoot**

## Decision

The patient header block goes in `<thead>` and the footer (signatories, QR, disclaimers, contact strip) in `<tfoot>` of one
outer layout table whose single `<tbody>` cell holds the report body. Chromium repeats both on every printed page.

Chosen because:
- one DOM and one stylesheet: the bundled fonts (Noto Sans Devanagari patient names), the shared print stylesheet and
  `data:` images (QR, signatures, letterhead) apply to the header/footer exactly as to the body;
- header/footer height follows content; no fixed page margin has to be sized to the tallest patient block;
- the guard (only `data:` passes) and JS-off rules need no exception.

Rejected:
- `page.pdf` header/footer templates (`displayHeaderFooter`): also repeated on every page in the run below, but the
  templates are a separate document — no page CSS, every style inline — and the page margin must be fixed to the
  header/footer height up front. Rejected for the CSS split.
- fixed-position elements (`position:fixed` in the page margin): page 1 lost the footer and page 3 lost the header in
  the run below. Rejected as unreliable.

Known limit: on the last page the `<tfoot>` follows the body directly instead of sitting at the page bottom; templates
pad the body cell (min-height) where a bottom-anchored final footer is needed (C6-T06+).

**"Page N Of M" is not produced by Chromium** under any technique: the sandbox stamps it after merging (02-TRD §5.2),
so outsourced pages are counted. Templates leave space for it; `page.pdf` `pageNumber`/`totalPages` classes are not used.

## Evidence

3-page A4 document (`@page{size:A4;margin:25mm 10mm}`, three 230 mm body blocks), same header/footer text, rendered by
`createPool()` (JS off, request guard on), per-page text extracted from the PDF:

```
thead-tfoot            pages 3 p1: hdr=true ftr=true  | p2: hdr=true ftr=true | p3: hdr=true  ftr=true
fixed-position         pages 3 p1: hdr=true ftr=false | p2: hdr=true ftr=true | p3: hdr=false ftr=true
page.pdf-header-footer pages 3 p1: hdr=true ftr=true  | p2: hdr=true ftr=true | p3: hdr=true  ftr=true
```

## Watermark (04-UI-UX §Watermark: "confirmed per page by spike C6-T05")

**Watermark technique: `position: fixed`, centred (`top/left:50%`, `translate(-50%,-50%)`), `rotate(-30deg)`, 48 pt,
low opacity**, as 04-UI-UX specifies. Unlike the margin header/footer above (placed outside the page box, lost on
p1/p3), a fixed element inside the page area is repeated by Chromium on every page. Run: same 3-page A4 body, one
fixed watermark div, opacity .08:

```
watermark position:fixed  pages 3 p1: wm=true | p2: wm=true | p3: wm=true
```

Evidence from the PDF: each page's content stream paints its own Form XObject (Skia puts `opacity` into a
transparency group, ExtGState `/G3`), and each of the three Forms holds the same rotated `cm` matrix and the same
9-glyph `Tj` (the watermark text). Extractors must follow `Do` into Form XObjects to see it.

The gate is the acceptance test, not this table: `src/__tests__/spike-assets.test.ts` renders the recorded technique and
asserts header + footer text on every page (AC-03.2).

## Other renderer decisions [CONV]

- Fonts: `fonts/` holds Noto Sans (Regular/Bold), Noto Sans Devanagari (Regular/Bold), Noto Sans Mono (Regular) static
  TTFs from notofonts (OFL-1.1, `fonts/OFL.txt`). Installed into fontconfig in the image only (02-TRD §5.1: system
  fonts, templates name the bundled families, no `@font-face`). Hosts without them installed render with fallbacks.
- Pool saturated: a job that gets no context within `LIMS_RENDERER_TIMEOUT_MS` fails 503 (worker retries).
- One fresh browser context per job, at most `LIMS_RENDERER_CONTEXTS` at once (no state shared between renders).
- Recycle runs only when no other job is in flight; a crashed browser is relaunched by the next job; in-flight jobs
  on a crashed browser fail with 503 (worker retries).
- Blocked navigations (meta refresh) are answered 204 so the document stays; `file:` subresources are refused by
  Chromium itself and counted from its console message.
