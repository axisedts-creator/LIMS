// HelpPanel content for helpKey `anatomic.config.template` (C11 04-UI-UX §4.7). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Synoptic template editor',
  sections: [
    { heading: 'Sections and fields', body: 'Add sections, then fields. Each field has a key (lower case letters, digits and underscore, starting with a letter) that cannot repeat anywhere in the template. Section keys are made from the section headings.' },
    { heading: 'Show if', body: 'A field can appear only when an earlier yes/no or select field has a given answer. The trigger field must come before the field that depends on it.' },
    { heading: 'Preview', body: 'The preview on the right is what the pathologist sees in the report editor. Typing in the preview does not save anything.' },
    { heading: 'Saving and publishing', body: 'Save draft stores your changes. Publish the template from the Synoptic templates list when it is ready; after that it cannot be changed, only replaced by a new version.' },
    { heading: 'Your own text', body: 'Write your own checklists. Do not copy protocol text you do not have rights to.' },
  ],
  shortcuts: [],
  links: [{ routeId: 'staff.anatomic.config', label: 'Pathology setup' }],
};
