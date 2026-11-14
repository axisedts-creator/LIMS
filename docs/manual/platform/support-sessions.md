# Support sessions

## Purpose

LIMS provider staff work inside a tenant lab only through a support session: time-limited, with a reason and a ticket, and visible to the lab's administrators. Address: `/platform/support-sessions`. Permission: `platform.tenant.read`; opening a session needs `platform.support_session.open`.

## Fields

The **Open support session** dialog has:

- **Tenant**: the lab.
- **Scope**: Read only or Admin. Admin is available to superadmins only.
- **Reason** (10 to 500 characters): what you need to do. No patient details in the reason.
- **Ticket reference** (1 to 60 characters).
- **Duration** in minutes: 5–60, default 30.

## Steps

### Open a session

1. Select **Open support session**.
2. Choose the tenant and scope, enter the reason and ticket reference, and set the duration.
3. Submit. If the lab requires approval, wait until an administrator approves it.
4. On the active session card, select **Go to tenant admin** to work in the lab. A countdown shows the time left.

### End a session

Select **End** on the active session card as soon as the work is done. The session also ends by itself when the time runs out, or when the lab administrator ends it.

Everything you change during the session is marked as support work in the lab's audit log.
