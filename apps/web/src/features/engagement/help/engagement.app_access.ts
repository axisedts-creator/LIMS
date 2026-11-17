// HelpPanel content for helpKey `engagement.app_access` (C16 T-DOC1). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Patient app access',
  sections: [
    { heading: 'Before you issue a code', body: 'Check the identity of the person first: a photo ID, a guardian photo ID for a child, or a patient you know as a regular. Record who gave consent. A guardian is required when the patient is under the minor age set by the lab.' },
    { heading: 'What the code does', body: 'The code works once and only on the phone number it was issued for: the number on record or another number you type. Whoever uses it sees the full history of this patient in the app, including earlier reports, so never issue it without the identity check. The code is shown once; closing the panel hides it for good.' },
    { heading: 'Revoking access', body: 'Revoke an app link when the patient asks, when misuse is suspected or when the link was made by mistake. Choose the reason; it is recorded. The patient loses access to these reports at once.' },
  ],
  links: [{ routeId: 'staff.engagement.app_access', label: 'Patient app access' }],
};
