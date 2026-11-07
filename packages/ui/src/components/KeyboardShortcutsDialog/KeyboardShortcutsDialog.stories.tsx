import { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';

const groups = [
  { id: 'global', title: 'Global', shortcuts: [{ keys: '?', description: 'Show keyboard shortcuts' }, { keys: 'Alt+N', description: 'Focus navigation' }] },
  { id: 'page', title: 'This page', shortcuts: [{ keys: 'Alt+R', description: 'Receive specimen' }] },
];

export default { title: 'Overlays/KeyboardShortcutsDialog', component: KeyboardShortcutsDialog, args: { isOpen: true, onClose: () => {}, groups } };

export const Open = {};
