APPROVE

Scope: git diff a1213d3d..HEAD (ruling test fixes, notes) plus the full WEB-T05 impl (d768df0b, c25fb01a), which no earlier review had covered.

- Ruling 451c9598: all 4 test changes match it exactly (:176, :229, :290, :628/:647). No assertion was weakened beyond what the ruling allows.
- Names match 02-TRD E33–E39/E42 verbatim: paths (E37 `/attachment/content`, 08 A13 P-2), coded set `instruments.g_cs_reprocess_reasons`, barcode regex `^[A-Z0-9]{1,40}$`, reason_text ≤300. E38/E39 send Idempotency-Key and no If-Match (A-class).
- done_when: the barcode goes only in the POST JSON body (searchInstrumentMessages.server.ts:13, rematchInstrumentRecord.server.ts:11). Raw is cleared on close (the drawer unmounts and its effect cleanup resets state, RawMessageDrawer.tsx:21; MessageDetail.tsx:171). Download goes through a same-origin BFF stream with redirect:'error', a MIME allowlist, nosniff/no-store/CSP sandbox and a forced `attachment` disposition. No Storage URL is involved.
- Reprocess/Re-match are gated on `instruments.message.rematch` (canRematch). Re-match rejects an equal barcode on the client too (AC-19.5). There is no PHI in logs or error texts and no secrets. All paths are owned.
- Ran WEB-T05-verify config: 2 files, 171/171 pass (43 s).

Non-blocking gaps (not defects in this diff): there is no Playwright E2E, although the brief lists "component, E2E". There is no Centre filter and no cursor paging past 50. Both are noted as open in WEB-T05-impl.md.
