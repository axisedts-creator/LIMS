# Credit parties and affiliations (SCR-12)

Route: `/catalog/credit-parties` and `/catalog/credit-parties/{id}`. Permission to view: `catalog.price_list.read`; editing needs `catalog.price_list.manage`.

## Purpose
Hospitals, companies, clinics, partner labs and insurers that send patients. A party can have its own price list and may be allowed to buy on credit.

## List
Columns: Code · Name · Kind · Credit allowed (Yes/No) · Price list · Status.

## Billing
Credit limits, credit days and monthly statements are managed in Billing.

## Fields
- **Party code**: pattern `^[A-Z0-9_\-]{1,20}$`; leave blank for an automatic `CP00001` style code.
- **Name**: 1–160 characters.
- **Kind**: Hospital, Company, Clinic, Partner lab, Insurer, Other.
- **Credit allowed**: Off = affiliation with its own prices; patients still pay at the counter.
- **PAN** (up to 20), **Phone** in E.164 format (for example +9771400000000), **Email**, **Billing address** (up to 500), **Active**.

PAN, phone, email and billing address are shown and editable only for users holding `catalog.price_list.manage`.

## Keys
`/` focus search, `n` new party, `Ctrl+S` save, `Esc` close, `?` shortcut help.
