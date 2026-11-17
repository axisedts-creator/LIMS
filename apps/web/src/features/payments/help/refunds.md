# Gateway refunds

## Purpose
Follows every refund of an online payment (eSewa, Khalti) from the first request to the day the money is paid back. A refund is only "Completed" when the provider confirms it and the server has recorded it. Nothing here pays money out by itself on eSewa; on Khalti the provider API is used only if your administrator turned it on.

## The steps
1. **Waiting for approval**: someone asked for a refund from the payment page. A second person must approve it. You cannot approve your own request, unless the amount is at or below the limit your administrator set.
2. **Approve** or **Reject**. Rejecting needs a reason from the list. Approving may have a short note.
3. **Refund in progress**: the refund is approved. For a manual refund, pay the patient back in the provider's merchant dashboard, then press **Confirm refund done** and enter the provider's refund reference and the date. For the provider API, the refund is sent automatically.
4. **Completed** once the provider shows the refund. If the provider does not show it yet, the refund is **Under review** and is checked again every night.

## Other buttons
- **Re-check**: asks the provider again right now. If you press it twice in a row you are asked to wait a few seconds.
- **Mark refund failed**: only when the provider confirmed that no refund was made. The provider is checked first. No ledger entry is written, and a new refund can be requested afterwards. A reason is needed.

## Filters and columns
Filter by status, gateway and the date the refund was created. Columns: Requested, Gateway, Amount, Status, Mode (Manual or Provider API), Requested by, Approved by, Reason under review and Intent. Status is always written in words.
