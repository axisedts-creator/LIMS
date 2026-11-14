# Phlebotomy phones

## Purpose
Lists the phones that phlebotomists use for home collection: who has which phone, which app version it runs, and when it last contacted the system.

## Reading the table
- **Status** is written in words: **Active**, **Signed off**, **Wipe requested** or **Wiped**.
- **Update required** appears next to an app version that is older than the minimum your lab has set in Settings. The phone must be updated before it can be used safely.
- **Last seen** is the last contact. **Last upload** is the last time the phone sent its work. **Last route download** is the last time it received its visits. A phone that never did one of these shows **Never**.

## Wipe on next connection
Use this when a phone is lost, stolen, retired or given to someone else.
1. Open the **⋯** menu on the phone's row and choose **Wipe on next connection**.
2. Choose a reason. Choose **Other** only if none fits, and then describe it in the details box.
3. Confirm. The phone uploads any pending changes the next time it connects, then erases all home-collection data.

The wipe does not block the phone straight away. To block it immediately, also revoke the user's sessions in Admin → Users.

A phone that has signed off can still be wiped. A phone that is already wiped has no wipe action.

## Who can do this
Only people with permission to manage phones see the wipe action.
