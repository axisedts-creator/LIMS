// HelpPanel content for helpKey `instruments.settings` (SCR-11). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Instrument settings',
  sections: [
    { heading: 'Settings', body: 'Tenant defaults for agents: backlog thresholds, clock warning, local retention on the PC and the update window. Changes reach agents within a minute.' },
    { heading: 'Raw message retention', body: 'Raw analyser messages are kept for the period set in the lab\'s retention settings (Administration), at least one year. Legal retention is not yet confirmed.' },
  ],
  links: [{ routeId: 'staff.instruments.agents', label: 'Agents' }],
};
