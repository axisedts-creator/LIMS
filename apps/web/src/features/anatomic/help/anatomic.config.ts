// HelpPanel content for helpKey `anatomic.config` (C11 04-UI-UX §4.7). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Pathology setup',
  sections: [
    { heading: 'Who can change this', body: 'Only users with the pathology setup permission. Saving needs two-factor verification; the screen asks for it when it is missing.' },
    { heading: 'Lists and drawers', body: 'Each tab is a list. Choose Add to create a row or Edit to change one; the form opens on the right and has its own Save. Codes cannot be changed or deleted after saving, only deactivated.' },
    { heading: 'Default routine stain', body: 'The default routine stain must be an active routine stain. To deactivate it, choose another default on the Settings tab first.' },
    { heading: 'Coded lists', body: 'Add only codes your lab is licensed to use. No external code sets are included.' },
    { heading: 'Synoptic templates', body: 'Templates are drafts until published. A published template cannot be changed: create a new version, edit it, then publish it. Reports already signed out keep the version they used.' },
  ],
  shortcuts: [],
  links: [{ routeId: 'staff.anatomic.worklist', label: 'Pathology cases' }],
};
