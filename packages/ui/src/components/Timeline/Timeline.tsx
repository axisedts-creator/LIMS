import { formatDateTime } from '../_shared/time';
import { msg, type Tone } from '../_shared/messages';

export interface TimelineProps {
  /** Shown in the order given (callers sort). */
  items: readonly { at: string; label: string; actor?: string; tone?: Tone }[];
  'data-testid'?: string;
}

export function Timeline({ items, ...rest }: TimelineProps) {
  return (
    <ol className="lims-timeline" {...rest}>
      {items.map((it, i) => (
        <li key={i} className="lims-timeline-item" data-tone={it.tone ?? 'neutral'}>
          <time className="lims-timeline-time" dateTime={it.at}>
            {formatDateTime(it.at)}
          </time>{' '}
          {it.tone && it.tone !== 'neutral' ? <span className="lims-timeline-tone">{msg.toneText[it.tone]}: </span> : null}
          <span className="lims-timeline-label">{it.label}</span>
          {it.actor ? (
            <>
              {' · '}
              <span className="lims-timeline-actor">{it.actor}</span>
            </>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
