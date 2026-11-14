# RS-C15 impl (writer; LD-140, LD-170)
Files: components/ReconciliationView.tsx (A1 "Our status" chip, generic kind + payment_intent tone, em dash when absent), IntentDetailView.tsx (A2 refund chips via refundStatus), SettingsView.tsx (A3 status chip in eSewa/Khalti/Fonepay cards), RefundsList.tsx (Approve / Confirm refund done / disabled Approve: primary -> secondary).
[CONV] A3 chip shows the SAVED account state (account.is_enabled), not the unsaved switch; the Enabled switch stays the control. Chip sits first in the card, under the title (kit Card has no title-actions slot).
[CONV] No API, field, validation, permission, route or server/** change. No raw colour, px radius or inline style added.
NOT RUN: vitest could not start from this session (shell command needing approval was denied; apps/web has no node_modules here). Tests unverified.
OPEN: `__snapshots__/rs-c15.screens.test.tsx.snap` NOT recorded (LD-170: writer records once, last, `-u rs-c15.screens`, after the other tests pass). pg-t18/pg-t19 chunk tests not run.
