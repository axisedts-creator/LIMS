// HelpPanel content for helpKey `partners.manifest_editor` (C13 T25). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Edit manifest',
  sections: [
    { heading: 'Adding lines', body: 'Add one line per patient. Enter the patient details, your own sample reference and the tests or panels you need. A manifest holds a limited number of lines, set by the lab.' },
    { heading: 'Consent', body: 'For every line you must confirm that the patient gave consent, using the statement shown on the page. The lab keeps which version of the statement you confirmed. You cannot submit a line without this confirmation.' },
    { heading: 'Saving and submitting', body: 'Changes are saved to the draft. Submit sends the manifest to the lab and locks it. If someone else changed the draft first, reload the page and try again.' },
  ],
  links: [{ routeId: 'partner.manifest', label: 'Manifest' }],
};
