# T0D-MSGDESK-1 contract gaps found by the tester (no CR filed: tester role may write notes only; lead decides)

1. **Names for Requested By / Approved By.** `Broadcast.requested_by` / `approved_by` are bare user ids (broadcast.service stores `ctx.actor.id`, the user id). No web read maps a user id to a name
   (`listUsers` returns `membership_id`, `getMe` returns only `membership_id`). The screen cannot show a person name. Tests pin: cell never blank/"undefined", "You" for my own, em dash for no approver.
   Ask: add `requested_by_name` / `approved_by_name` (or PersonRef like payments refunds) to `Broadcast`.
2. **Who am I (second person rule display).** The shell session has only `membershipId` (optional). To disable Approve for the requester the page needs the user id. Tests pin ONE seam: the server page reads
   the JWT `sub` claim of the access token it already holds (`getAccessToken`) and compares it with `requested_by`. If the lead prefers another seam (for example `membership_id` on `Broadcast`), say so before the writer starts.
3. **No `getBroadcast` operation.** The per recipient history therefore lives on the broadcasts page (`?broadcast=<id>`), template channel comes from the template list. A broadcast older than the newest 200 cannot be looked up by id.
4. **Ticket Party column.** `PartnerTicket` has `party_id` only; the inbox resolves the partner name through the existing `/v1/partners/admin/partners` list (tests serve it). A partner outside the first page shows no name.
5. **No "Activate" for a template and no "Reopen to new"**: reopen returns the ticket to `replied` per the stand-in only; the contract text says only "reopen". Tests do not pin the status after reopen.
