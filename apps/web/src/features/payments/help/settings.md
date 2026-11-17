# Payment gateways

## Purpose
Where an administrator connects the lab to eSewa and Khalti. The banner at the top says which environment this system is using: UAT (practice, no real money) or Production (real payments). Only that environment is shown here.

## eSewa and Khalti cards
- **Enabled**: patients can only pay online with a provider once it is enabled. Enabling needs the provider's key and, for eSewa, the product code; for Khalti, your website address (it must start with https://).
- **Key**: you can type a new key but never read the saved one. After saving, the card shows only the date it was set and a short fingerprint, and the field is empty again. To change it, type the new key in "Replace" and save.
- **Use Khalti refund API**: off unless the LIMS provider confirmed the refund service for your account. When off, refunds are paid back in the Khalti dashboard and confirmed in LIMS.
- **Save** stores the card. **Test connection** asks the provider if it can be reached. For eSewa the key cannot be proven without a real payment, so make a small test payment in UAT before going live.

## Fonepay
Fonepay is not available yet. Its card stays read-only until the bank's integration document is received.

## Refunds and labels
- **Two-person threshold**: refunds above this amount always need a second approver. 0 means always.
- **Order label sent to Khalti**: shown to the patient on the Khalti page. Never put patient or test names in it.
- **Nightly reconciliation**: turns the nightly comparison with the providers on or off.
