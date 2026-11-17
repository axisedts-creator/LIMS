## debugger 2026-11-18
Cause: registry-equality.test.ts:106 allow list lacks the 6 catalog.import_* error codes that T0C-TESTIMPORT-1 (LD-318) legitimately added to contracts/errors.yaml. Not caused by CONTENT-1; no implementation change possible.
Fix: none in implementation. Test must add the 6 codes; see T0C-CONTENT-1-dispute.md. Stopped per rule.
