# CR T0B-REGAPI-2: receipt number preview needs a billing port method
- Requested by: T0B-REGAPI-2 writer (lane C0-0B), 2026-11-17.
- Need: previewRegistrationNumbers must return the next bill receipt number without consuming it (done_when 5). The RC counter is billing.fiscal_counters (series RC, per BS fiscal year); frontdesk may not read billing tables (08 R25) and contracts/ports/BillingCommandPort.ts has no read-only preview method.
- Proposal: add `previewReceiptNo(ctx, {}): Promise<{ receiptNo: string }>` to BillingCommandPortV1 (read last_no + 1, format with numbering.receiptNoPattern, no write), implement in billing/ports/BillingCommandPort.impl.ts and the fake.
- Interim (shipped): frontdesk calls `BillingCommandPort.previewReceiptNo` when present; otherwise renders receiptNoPattern with seq 1 (correct shape, not the real next number). Marked `ponytail:` in service/parity.service.ts.
- Related open point: registration payments use issueReceiptNo=false (the invoice is the receipt, PRD D-RECEIPT); the lead should confirm whether "bill receipt number" means the next INV number instead of RC.
