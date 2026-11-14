// HelpPanel content for helpKey `instruments.agents` (SCR-01). Plain data (C0 04-UI-UX §7).
export default {
  title: 'Agents',
  sections: [
    { heading: 'What is an agent?', body: 'An agent is the bridge program on a lab PC that connects analysers and uploads their messages. Create one agent for each lab PC.' },
    { heading: 'Health', body: 'Online: the agent is connected. Backlog: messages are waiting on the PC. Instrument silent: an instrument has sent nothing in its expected window. Offline: the agent has stopped reporting.' },
    { heading: 'Installing', body: 'Open the agent, issue an enrolment code and paste it into the installer on the lab PC. The code works once and expires in 24 hours.' },
  ],
  // SCR-01 Alt+N clashes with the global Alt+N (core/shortcuts GLOBAL_KEYS) — not registered, see CR-C7-WEB-T02-d.
  shortcuts: [{ keys: 'Alt+E', action: 'Issue enrolment code (agent page)' }],
  links: [{ routeId: 'staff.instruments.instruments', label: 'Instruments' }],
};
