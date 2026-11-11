# BL-T22 impl (writer) — 2026-11-11
- Files changed: none (LD-98: writer changes nothing until BL-T15 lands; no stub faked, LD-75). Alert rule files (billing/alerts/cbms+integrity, frontdesk/alerts/frontdesk.rules.yaml) and CR (.orchestra/cr/BL-T22.nonblocking.md) already in HEAD.
- Verify run (`vitest run src/modules/billing/__tests__/probes`): 25 fail | 334 pass | 7 skip | 1 todo. alerts.rules, phi.logscan, uploads, securityContracts all pass.
- 17 fails = 9 BL-T15/B6 ops still `notYet` in services/api/src/modules/billing/handlers/index.ts:12,27 (getSalesRegister, getCancelledInvoiceRegister, getCreditNoteRegister, getAuditTrail, createBillingExport, getBillingExport, getBillingExportContent, listCreditNotes, getCreditNote). register.handlers.ts/export.handlers.ts not on main yet → BL-T15 (LD-97) not done; lane cannot clear these.
- 8 fails = real handler answers ≠ 404 (already listed in BL-T22-tests.md): frontdesk updatePatient, anonymisePatient, uploadTrf, getTrfAttachment, getTrfAttachmentContent, searchPatients (zero-rows); billing printInvoice, printCreditNote.
- [CONV] Per LD-98 these 8 are re-checked only after BL-T15 merges; if they persist they are C4-owned and get fixed then (not touched now to avoid acting outside the ruling).
- Open: BL-T22 stays GATED on BL-T15 (LD-97).
