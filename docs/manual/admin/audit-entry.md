# Audit entry

## Purpose

An audit entry shows one recorded change in full: who made it, from where, and the value of each changed field before and after. Address: `/admin/audit/{audit_id}`. Permission: `audit.log.read`.

## Fields

- **Time** (in your lab's calendar, with UTC on hover), **User**, **Action**, **Table**, **Record id**.
- **Request id**: links all changes made by one save. Search the audit log by request id to see them together.
- **IP**, **User agent** (browser), **Centre**.
- **Support session**: set when the change was made during LIMS provider support access.
- **Differences**: a table of the changed fields with the old and new value of each.

Your viewing of this entry is recorded, because entries can contain personal details.

## Steps

### Check a change

1. Open the entry from the [audit log](audit.md).
2. Read the differences table: each row is one changed field.
3. To see other changes from the same save, copy the request id and filter the audit log by it.

### Report a suspicious change

Note the time, user and request id, and follow your lab's incident procedure. If the change was made during support access, also check [Support access](support-access.md).
