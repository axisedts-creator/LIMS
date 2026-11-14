import { Icon } from '../Icon/Icon';

export interface StatTileProps {
  label: string;
  value: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; isGood?: boolean };
  /** App-relative link (e.g. '/lab/reports?status=pending'); anything else is not rendered as a link (REQ-SEC-088). */
  href?: string;
  'data-testid'?: string;
}

const WORD = { up: 'Up', down: 'Down', flat: 'No change' } as const;
// One icon family: svg icons, no text glyphs (LD-140, 10-DESIGN-SYSTEM §6).
const ARROW = { up: 'arrow-up', down: 'arrow-down', flat: 'minus' } as const;
const safeHref = (h: string | undefined) => (h && /^\/(?!\/)/.test(h.trim()) ? h.trim() : undefined);

export function StatTile({ label, value, delta, href, ...rest }: StatTileProps) {
  const tone = !delta || delta.direction === 'flat' || delta.isGood === undefined ? 'neutral' : delta.isGood ? 'success' : 'danger';
  const body = (
    <>
      <span className="lims-stat-label">{label}</span>
      <span className="lims-stat-value">{value}</span>
      {delta ? (
        <span className={`lims-stat-delta lims-tone-${tone}`} data-tone={tone}>
          <Icon name={ARROW[delta.direction]} size={14} /> {WORD[delta.direction]} {delta.value}
          {delta.isGood !== undefined && delta.direction !== 'flat' ? <span className="lims-stat-judgement">{delta.isGood ? ' (better)' : ' (worse)'}</span> : null}
        </span>
      ) : null}
    </>
  );
  const link = safeHref(href);
  return link ? (
    <a className="lims-stat lims-stat-link" href={link} {...rest}>
      {body}
    </a>
  ) : (
    <div className="lims-stat" {...rest}>
      {body}
    </div>
  );
}
