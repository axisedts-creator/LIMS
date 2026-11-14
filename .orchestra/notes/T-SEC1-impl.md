# T-SEC1 impl (writer)
- apps/patient_app/android/.../MainActivity.kt: registers `lims_ui/secure_screen` channel; `enable` addFlags(FLAG_SECURE), `disable` clearFlags [CONV channel name from lims_ui LimsSecureScreen]. REQ-SEC-109.
- Result: 62 pass, 1 fail (was 61/2). FLAG_SECURE test now passes (static check only; no Android build run).
- OPEN: "none is still the T-01 placeholder" still fails for E13, E18, E19, R4 — see T-SEC1-dispute.md (no plan row owns the handlers; not implemented).
