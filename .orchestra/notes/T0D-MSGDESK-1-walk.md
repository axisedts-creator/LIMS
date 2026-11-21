# T0D-MSGDESK-1 walk (writer) — ElabAssist Messages / Message To Laboratory vs LIMS
Source: the brief's EVIDENCE summary of C:/LIMS-state/elabassist-other-20261117.md (this session had no read access to the file itself) and a code walk of the LIMS screens.

LIMS screens that existed before this task (walked in code):
- Staff engagement: queue, bookings, reminders, enquiries, memberships, slots, bookable items, queue setup, settings, portal content. None of them sends a message to a party audience; reminders are per patient only.
- Staff partners: inbox (manifests), pickups, partners, referrers, settings, sales (4), onboarding, penalties, penalty events. No ticket or message screen.
- Partner portal: dashboard, orders, reports, manifests, pickups, price list, statements, referrers, users, account. No way to write to the lab.

What each new LIMS screen replaces:
- /engagement/messages/templates (Message Templates) replaces ElabAssist Messages > Create New Template: Name, Channel (SMS, WhatsApp, Email), Active, a placeholder helper with the closed list {{party_name}} {{lab_name}} {{lab_phone}} {{send_date}}.
- /engagement/messages/broadcasts (Messages) replaces ElabAssist Messages (audience selection and Send) and its Log page: audience builder with a live recipient count and a masked sample, Save draft, Request approval, Approve by a second person, Cancel; ?broadcast=<id> is the per recipient log (Recipient, Type, Channel, Status) with masked addresses.
- /partners/tickets (Message To Laboratory) replaces ElabAssist Message To Lab (lab side): Ticket, Party, Subject, Status (New, Replied, Closed), Last Reply; /partners/tickets/<id> is the thread with Reply, Close and Reopen.
- Partner portal /tickets, /tickets/new, /tickets/<id> replace the partner side of Message To Lab: My tickets, New ticket, thread with replies. Status words New, Replied, Closed.

What is missing (not built here):
- Real sending: the founder must configure and approve a provider; until then Approve is refused by the API (no provider) and nothing leaves the outbox.
- WhatsApp logger and payment logger pages of ElabAssist: no contract operation; the recipient log covers broadcasts only.
- Activity log of messages: the broadcast list is the log; no separate activity page.
- Person names for Requested By / Approved By (the contract has a user id only; shown as You / Another user), see notes/T0D-MSGDESK-1-cr-needed.md.
- Recipient log paging beyond the newest 200; a broadcast older than the list page cannot be opened by id (no getBroadcast).
- City and priority filters of the audience (in the contract, not yet in the builder); offline queueing of ticket replies (T0D-OFFLINE tasks).
