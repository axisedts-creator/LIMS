// HelpPanel content for helpKey `engagement.queue` (C16 T-DOC1). Plain data; LD-140: no colours or sizes here.
export default {
  title: 'Queue console',
  sections: [
    { heading: 'Serving the queue', body: 'Pick your counter, then call the next token. Use Recall if the person did not come, Serving when they arrive, Done when finished, or Skip and Transfer when needed. The list refreshes by itself every few seconds.' },
    { heading: 'Issuing tokens', body: 'Issue a token for a walk-in and print the slip. The slip shows only the lab name, queue, token and time. With nobody waiting, Call next tells you that no one is waiting.' },
  ],
  shortcuts: [
    { keys: 'Alt+C', action: 'Call next' }, // CR-C16-T-Q4-a: Alt+N is a C0 global key; console registers Alt+C
    { keys: 'Alt+R', action: 'Recall' },
    { keys: 'Alt+S', action: 'Mark as serving' },
    { keys: 'Alt+D', action: 'Mark as done' },
    { keys: 'Alt+K', action: 'Skip' },
    { keys: 'Alt+T', action: 'Transfer to another queue' },
    { keys: 'Alt+I', action: 'Issue a token' },
  ],
  links: [{ routeId: 'staff.engagement.queue', label: 'Queue console' }],
};
