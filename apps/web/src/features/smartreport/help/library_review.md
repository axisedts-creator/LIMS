# Library review and approval

## Purpose

Read a submitted library version end to end and approve it, or send it back. Approval is privileged: it needs the smartreport.template.approve permission and is for the lab's named pathologist.

## What you see

Every tab in read-only form, plus "Changes since active version": counts of added, changed and removed texts, rules and mappings. Use it to find what is new, but read all patient-facing text.

## Actions

- **Approve**: confirm that you reviewed every text, rule and interval. An optional note (up to 500 characters) can be added. The version becomes the active one and the previous version is retired.
- **Return to draft**: a comment is required (1 to 1000 characters). The author sees the comment and can edit again.

## What is recorded

The approval is recorded with your identity, the date and time, and a content hash (SHA-256) of the exact text you approved. Later, anyone can show which exact wording was approved, by whom and when. If a second sign-in check is needed, the app asks for it.

## Good to know

The author may also be the approver in a small lab. Even then, the approval is a separate, deliberate step.
