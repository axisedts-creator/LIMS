# Approval responsibilities (B14)

Under decision B14, every sentence a patient reads in a smart summary is written or approved by the lab's **named pathologist**. This page explains what that means in daily work.

## Two approvals

1. **Library approval.** The library version is approved at `/smartreport/library/{library_version_id}/review` with the permission smartreport.template.approve. The pathologist confirms that they reviewed every text, rule and interval.
2. **Summary approval.** Each summary is approved at `/smartreport/summaries/{summary_id}` with the permission smartreport.summary.approve. Every summary is read by the pathologist before the patient can see it. The confirmation says: "I have read every sentence and confirm it is appropriate for this patient."

Both approvals are privileged. They cannot be given by system accounts or by people without the permission.

## Traceability

Each approval records who approved, when, the library version and a content hash of the exact text. A complaint can be answered with "this exact text was approved by Dr X on date Y". Rejections and replaced summaries are kept in the history too.

## Responsibilities of the named pathologist

- Read the full library before approving it. Return it to draft with a comment if anything is unclear.
- Read each patient summary, including the Results used panel, before approving.
- Reject a summary with a reason when wording or content is not right for that patient.
- Accept or change the default health score settings knowingly (see [health score](health-score.md)).

## Small labs

The author may be the approver. A lab manager can write drafts but cannot approve them. In a small lab the same person can write and approve, as the pathologist, in two separate steps.

## No pathologist appointed

Until a named pathologist is appointed with the approval permissions, no library can be approved, so no summary can be built or shown. Appoint one in user management first.
