import { Dialog } from '../Dialog/Dialog';

export interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Global shortcuts first, then the current page's (04-UI-UX §4 `?`). */
  groups: readonly { id: string; title: string; shortcuts: readonly { keys: string; description: string }[] }[];
  'data-testid'?: string;
}

export function KeyboardShortcutsDialog({ isOpen, onClose, groups, ...rest }: KeyboardShortcutsDialogProps) {
  return (
    <Dialog title="Keyboard shortcuts" isOpen={isOpen} onClose={onClose} size="md" {...rest}>
      {groups.map((g) => (
        <section key={g.id} className="lims-shortcuts-group">
          <h3 className="lims-shortcuts-title">{g.title}</h3>
          <dl className="lims-shortcuts">
            {g.shortcuts.map((s, i) => (
              <div key={i} className="lims-shortcuts-row">
                <dt>
                  <kbd className="lims-kbd">{s.keys}</kbd>
                </dt>
                <dd>{s.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Dialog>
  );
}
