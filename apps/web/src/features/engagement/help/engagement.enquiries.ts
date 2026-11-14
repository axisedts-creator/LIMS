// HelpPanel content for helpKey `engagement.enquiries` (C16 T-DOC1). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Enquiries',
  sections: [
    { heading: 'Reading and replying', body: 'Enquiries are messages patients send from the app. Open one to read the thread and write a reply of up to 2000 characters. Send with Ctrl+Enter and close the thread when it is answered.' },
    { heading: 'What not to write', body: 'Do not put test results in a reply. Ask the patient to open the report in the app. Replies are not a safe place for medical results.' },
  ],
  shortcuts: [
    { keys: 'Ctrl+Enter', action: 'Send the reply' },
    { keys: 'Alt+X', action: 'Close the enquiry' },
  ],
  links: [{ routeId: 'staff.engagement.enquiries', label: 'Enquiries' }],
};
