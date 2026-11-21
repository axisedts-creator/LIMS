// T0D-UIKIT-2 (LD-436 "Needs you", LD-437 exact mock): rows of tone icon chip, title, one detail line, count Badge, chevron.
// The kit never sorts: the caller puts the most urgent row first.
import type { Tone } from '../_shared/messages';
import { Badge } from '../Badge/Badge';
import { Icon, type IconName } from '../Icon/Icon';

export type ActionListItem = { id: string; title: string; detail: string; count: number; tone: Tone; icon: IconName } & (
  | { href: string }
  | { onPress: () => void }
);

export interface ActionListProps {
  items: readonly ActionListItem[];
  /** aria-label of the list. */
  label?: string;
  'data-testid'?: string;
}

/** Only relative or http(s) hrefs (same rule as PageHeader); javascript:, data: and the like get no href. */
const safeHref = (h: string) => (/^(\/(?!\/)|#|\?|https?:\/\/)/i.test(h.trim()) ? h.trim() : undefined);

export function ActionList({ items, label, ...rest }: ActionListProps) {
  return (
    <ul className="lims-action-list" aria-label={label} {...rest}>
      {items.map((it) => {
        const body = (
          <>
            <span className={`lims-action-chip lims-tone-${it.tone}`} data-tone={it.tone}>
              <Icon name={it.icon} size={14} />
            </span>
            <span className="lims-action-text">
              <span className="lims-action-title">{it.title}</span>
              <span className="lims-action-detail">{it.detail}</span>
            </span>
            <Badge tone={it.tone}>{it.count}</Badge>
            <Icon name="chevron-right" size={14} className="lims-action-chevron" />
          </>
        );
        return (
          <li key={it.id} className="lims-action-item">
            {'href' in it ? (
              <a className="lims-action-row" href={safeHref(it.href)}>{body}</a>
            ) : (
              <button type="button" className="lims-action-row" onClick={it.onPress}>{body}</button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
