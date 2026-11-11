# Patient portal

What a patient sees when they open a report link or scan the QR code on a printed report. The portal is built for phones: one column, large buttons. Staff can use this page to answer patient questions. The portal footer says "Your data stays on servers in Nepal."

## Opening a report

1. **Landing page.** Title "View your lab report". For security the portal sends a 6-digit code to the phone number or email the lab has on file. The patient presses "Send me a code".
2. **Code page.** The patient types the 6-digit code. It expires in 10 minutes. "Send a new code" is available after 60 seconds. A wrong code shows how many tries are left; a used-up code says to send a new one.
3. **Report page.** The patient sees the lab name, "Report for" their name, and a status: Final, Amended, Addendum, Partial, or Preliminary. A report that was updated shows the date of the update and says the patient is seeing the latest version. Download PDF and Sign out are on the page. A Health summary section appears only when the report has one.

The code page never shows the masked phone number or address.

## Dues

**Dues page `/r/{token}/dues`** (dues links only). Title "Payment due" with "Amount due: NPR {amount}" and "Your report will be sent once payment is complete." The page does not show the report status, test names, or a download. When online payments are live the patient sees a button for each gateway turned on in the settings ([settings.md](settings.md)): Pay with eSewa or Pay with Khalti. Otherwise the page says "Please pay at the lab counter or in the app." When the balance is 0 the page says "Payment received — your report will be sent once it is released."

**Report page dues card.** Shown only for patient links with an amount due: "Amount due: NPR {amount}" and the note "The exact amount is confirmed when you pay." The pay buttons follow the same rule as the dues page. If a payment is already open the card says "A payment is in progress." with a "See payment status" link.

**Payment status `/r/{token}/payments/{id}`.** The patient sees one of:

- "Preparing your payment…" — the page refreshes itself.
- "Continue to eSewa" / "Continue to Khalti" — the payment is ready; the button opens the gateway.
- "We are confirming your payment. This can take a few minutes."
- "Online payment is not available right now. Please pay at the lab counter or in the app."
- "Nothing is due on this report."
- "A payment for this order is already in progress."

**Payment return `/r/payments/{id}/done`.** Where the gateway sends the patient back:

- "Payment received. Thank you." with a "Back to your report" link.
- "Checking your payment…", then after a minute "We have not received confirmation yet. If you paid, it will show at the lab shortly."
- "The payment was not completed." with "Back to your report".
- "Open your report link again to see your payment status." — the browser session has ended; no data is shown.

The gateway's outcome value is never shown or trusted. Staff confirm a payment in billing, not from the patient's screen.

## Problems patients report

| Message | What it means |
|---|---|
| This link is not valid. It may have expired or been replaced. | The link is old, replaced, or revoked. The patient can ask for a new link; the answer is always the same wording, so nobody can learn whether a link ever existed. |
| Too many attempts. Please try again in {minutes} minutes. | The rate limit was reached. Ask the patient to wait. |
| Something went wrong. Please try again later. | A server problem. The page shows a reference id; use it when asking an operator to look. |

## QR verification

Scanning the QR code on a printed report opens a verification page:

- Green "This report is genuine." shows the laboratory, the patient's initials, the tests, the issue date, and the version.
- Amber "This report was replaced by a newer version." shows the same fields and asks the patient to get the current report from the laboratory.
- Neutral "We couldn't verify this report." means the code was not found. The patient should check they scanned the QR code on the report, or contact the laboratory.

## Accessibility

The portal works at narrow widths without sideways scrolling and announces the number of code tries left. The only time limits are the code and the session; both are stated in text.
