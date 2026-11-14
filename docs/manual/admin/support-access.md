# LIMS provider support access

## Purpose

LIMS provider support staff can only work in your lab through a time-limited support session with a reason and a ticket. This screen shows their requests, the sessions active now and past sessions, so you stay in control. Address: `/admin/support-access`. Permission: `audit.log.read`.

Whether a request needs your approval or only notifies you is set in [Lab settings](settings.md), tab Sign-in & sessions.

## Sections

- **Pending requests**: one card per request with the staff member's name, the reason, the ticket reference and the requested duration, and **Approve** and **Deny** buttons.
- **Active**: sessions running now, each with **End access**.
- **History**: past sessions with who, when, scope and how they ended.

## Steps

### Approve or deny a request

1. Read the reason and ticket reference on the card.
2. Select **Approve** to let the session start, or **Deny** to refuse it.

### End access early

Select **End access** on the active session. The support staff member is logged out of your lab at once.

### Review what support staff did

Changes made during support access carry a Support badge in the [audit log](audit.md); filter by the support session to see them all.
