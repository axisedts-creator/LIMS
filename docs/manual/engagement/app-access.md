# Patient app access

This page explains how to give a patient access to their reports in the app. It mirrors the in-app help for `engagement.app_access`. Screen: `/engagement/app-access/{patient_id}`. Viewing needs `engagement.link.read`; issuing a code needs `engagement.link.issue`.

## Before you issue a code

Check the person's identity first. Choose what you checked: photo ID, guardian's photo ID, or known regular patient. Record who gave consent, the patient or a guardian. A guardian is required when the patient is under the lab's minor age. Tick the confirmation that you checked the identity and that the person agreed.

## What the code does

- The code works once, and only on one phone number: the number on record or another number you type.
- A person who uses the code sees the full history of that patient in the app, including earlier reports. This is why the identity check matters.
- The result panel shows the code once, like `XXXXX-XXXXX`, with its expiry. Closing the panel hides it for good.
- Print slip gives a slip with the lab name, code, expiry and instructions. It carries no patient name.

## Relationship

Choose how the patient relates to the app user: Self, Child, Parent, Spouse, Sibling or Other. If the app account already has a Myself profile, a new Self profile is added as Other, and the user can change it.

## Revoking access

The linked accounts table lists phone (masked), relationship, method, status and date. Revoke a link or an unused code and choose a reason: Patient request, Suspected misuse, Staff error or Other. The patient loses access at once. Every issue and revoke is recorded in the access log.
