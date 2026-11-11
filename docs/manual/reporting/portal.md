# Patient portal

What a patient sees when they open a report link or scan the QR code on a printed report. The portal is built for phones: one column, large buttons. Staff can use this page to answer patient questions. The portal footer says "Your data stays on servers in Nepal."

## Opening a report

1. **Landing page.** Title "View your lab report". For security the portal sends a 6-digit code to the phone number or email the lab has on file. The patient presses "Send me a code".
2. **Code page.** The patient types the 6-digit code. It expires in 10 minutes. "Send a new code" is available after 60 seconds. A wrong code shows how many tries are left; a used-up code says to send a new one.
3. **Report page.** The patient sees the lab name, "Report for" their name, and a status: Final, Amended, Addendum, Partial, or Preliminary. A report that was updated shows the date of the update and says the patient is seeing the latest version. Download PDF and Sign out are on the page. A Health summary section appears only when the report has one.

The code page never shows the masked phone number or address.

## Dues

If a report is held for payment, the patient sees "Payment due" with "Amount due: NPR {amount}". The page does not show the report status, test names, or a download. When online payments are live the patient sees a button for each gateway turned on in the settings ([settings.md](settings.md)): Pay with eSewa or Pay with Khalti. Otherwise the page says to pay at the lab counter or in the app. After payment the patient is told the report will be sent once it is released.

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
