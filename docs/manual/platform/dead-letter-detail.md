# Dead letter

## Purpose

The dead letter page shows one failed background task and lets you replay or discard it. Address: `/platform/dead-letters/{dead_letter_id}`. Permission: `platform.dead_letter.manage`.

## Fields

Task, tenant, attempts, first failed at, dead at, last error code, error message (with personal details removed), state, resolved by and at, and the resolution note once resolved.

The job payload is never shown, so no patient data is exposed on this page.

## Steps

### Replay

1. Make sure the cause is fixed.
2. Select **Replay**. Optionally add a note (1 to 500 characters).
3. Confirm. The task runs again; the row is resolved.

### Discard

1. Select **Discard** when the task must not run again, for example because the work was done by hand.
2. Enter the reason (required, 1 to 500 characters) and confirm.

If someone else replayed or discarded the row meanwhile, you see "This record was changed by someone else. Reload to see the latest version." Select **Reload** and check the new state before acting.
