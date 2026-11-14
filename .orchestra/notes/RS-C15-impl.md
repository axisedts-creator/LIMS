# RS-C15 impl (writer; LD-140, LD-170)
Files: components/ReconciliationView.tsx (A1 "Our status" chip, generic kind + payment_intent tone, em dash when absent), IntentDetailView.tsx (A2 refund chips via refundStatus), SettingsView.tsx (A3 status chip in eSewa/Khalti/Fonepay cards), RefundsList.tsx (Approve / Confirm refund done / disabled Approve: primary -> secondary).
[CONV] A3 chip shows the SAVED account state (account.is_enabled), not the unsaved switch; the Enabled switch stays the control. Chip sits first in the card, under the title (kit Card has no title-actions slot).
[CONV] No API, field, validation, permission, route or server/** change. No raw colour, px radius or inline style added.
Round after ruling (tests revised a5a05d0a): no code change needed. Ran CI=true vitest: rs-c15 41/41, pg-t18 89/89, pg-t19 224/224 pass.
Snapshot `__snapshots__/rs-c15.screens.test.tsx.snap` recorded and tracked (LD-170); not re-recorded this round.
OPEN: tsc/lint not run on this lane; real layout/contrast unverified (jsdom only).
