# Price simulator (SCR-15)

Route: `/catalog/price-simulator`. Permission: `catalog.price_list.read`.

## Purpose
Check what a patient would pay before you publish or after you change a price list, surcharge or tax rule. Nothing is saved.

## Form
- **Orderables**: up to 50 tests or panels.
- **Priority**: Routine or Urgent.
- **Context** (all optional): Price list, Credit party, Doctor, Centre (centres need `identity.centre.read`), At (default now).

## Price source order
The Source column tells you why a list was chosen, in this order: Explicit, Hospital-company, Doctor, Centre, Default.

## Result table
Orderable · Price list used · Source · Version · Unit price · Urgent surcharge · VAT (Exempt/Taxable 13 %) · Other tax · HS code · Error.

## Tax
Tax treatment of lab services is pending confirmation by your auditor.
If the result shows an error about missing tax, add a lab default tax rule in Pricing › Tax.
