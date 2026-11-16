Cause: 2 reds are rs-c2.static baseline drift from T0D-WAKE-1 (actions.ts, messages.ts hashes, new auth/waking route), not MSERIES-6 code.
Fix: none in implementation (nothing to change). Dispute written: T0D-MSERIES-6-dispute.md. Tester must re-record rs-c2.baseline.json (RS_C2_RECORD=1) per T0D-WAKE-1 ruling item 1, then re-run verify.
