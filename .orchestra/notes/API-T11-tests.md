# API-T11 tests (tester)
Files (api): `__tests__/attachments.service.test.ts` (E06+E37 behaviour), `attachments.handlers.test.ts` (wiring), `unit/attachments.contract.test.ts` (OpenAPI), `attachments.helpers.ts` (SEAMS in header); `boot.test.ts` IMPLEMENTED += submitAttachment, downloadInstrumentAttachment.
Files (worker): `jobs/instruments/__tests__/scan-attachment.test.ts` + `scan-attachment.helpers.ts` (SEAMS in header).
Run all: `.orchestra\notes\API-T11-verify.cmd` (api via `pnpm --dir services/api exec vitest run ...`, worker via `pnpm --dir services/worker exec vitest run ...`).
Current state: contract test passes (spec-level); service/handlers/boot/worker fail because attachments.service.ts, attachments.handlers.ts, scanAttachment.ts do not exist / handlers are stubs.
Satisfiability: API service tests checked with a throwaway impl (42/44 passed; the 2 failures were the missing handlers file and a 255-char name -> Content-Disposition must stay <= 255, i.e. truncate file name). Scratch impl deleted. Worker tests NOT checked against any impl.
Seams to match (or dispute): AttachmentsRepo = IngestRepo + insertAttachment/findAttachmentByMessage; service gets `{metadata, file:{filename,mimeType,bytes}}`; handler maps core multipart `{filename, mimetype, data}` and JSON-parses a string `metadata`; E37 uses ctx.download.stream; worker ScanRepo + `createScanAttachment({repo})`, manifest task `instruments.scan_attachment` maxAttempts 5.
Not covered: real RLS/unique-index races (db tests), real ClamAV, qpdf sanitise (adapter), real multipart parsing.
