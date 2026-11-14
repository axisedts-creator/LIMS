# RS-C4 impl (LD-140, LD-170)
Files: frontdesk/components/{RegistrationForm,NewPatientForm,SuccessPanel,OrderView}.tsx + new frontdesk.css; billing/components/{CreditPartyDetail,InvoiceDetailView,InvoiceDocument}.tsx + new billing.css; snapshot __snapshots__/rs-c4.screens.test.tsx.snap (recorded last, LD-170).
Register: h2 Patient/Tests/Billing in one left column (Visit type moved into Patient; Billing mode, bill and payment merged into Billing); sticky `<aside aria-label="Registration summary">` (Tests, Total, Paid, Balance, Discount authority from quote.discount_evaluation); Register & print is the only primary and lives in the summary, "Use this new patient" is secondary.
[CONV] Age/DOB: both fields kept in one fieldset "Age or date of birth" (validation is "either, not both"). Statement: Opening = closing - invoiced + paid + credited (derived, no new data). All inline styles/hex removed under the 4 paths (tokens in the two .css files).
[CONV] Summary amounts use split spans, not MoneyText, so fd-t13 single-match text queries still pass.
Open: daily cash has no opening/closing in the API -> CR .orchestra/cr/RS-C4.md, columns unchanged. "Save draft" not added (brief). Real layout/contrast and Playwright not verified.
Ran: rs-c4 36/36, fd-t13 70/70, fd-t14 98/98, bl-t20 54/54 (fd-t14/bl-t20 before the summary span tweak), tsc clean for touched files.
