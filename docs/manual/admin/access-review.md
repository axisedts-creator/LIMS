# Access review

## Purpose

An access review is a regular check that every user still needs the roles and centres they have. This screen lists all users with their access and records when a review was completed. Address: `/admin/access-review`. Permission: `identity.user.read`.

## Columns

User, Roles, Centres, MFA, Last login, Status.

A banner shows "Last review" with the date and the administrator. It turns into a warning when the last review is more than 90 days old.

## Steps

### Run a review

1. Go through the list with the head of each department.
2. Look for users who left, users who have not logged in for a long time, and roles or centres beyond the job.
3. Fix each finding on the user's [user detail](user-detail.md) page: deactivate, change roles or narrow centre access.
4. Select **Record review completed**. Add notes (up to 2000 characters) describing what you checked and changed. The number of users reviewed is filled in automatically.

Repeat the review at least every 90 days.
