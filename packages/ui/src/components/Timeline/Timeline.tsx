import { formatDateTime } from '../_shared/time';
import { msg, type Tone } from '../_shared/messages';

export interface TimelineProps {
  /** Shown in the order given (callers sort). */
  items: readonly { at: string; label: string; actor?: string; tone?: Tone }[];
  /** T0D-UIGUARD-1-INVENTORY (LD-436 R7, LD-441 additive): a heading drawn above the list, in one block with it (e.g. a console "History"). */
  title?: string;
  /** T0D-UIGUARD-1-INVENTORY: the label leads each row, then the time (a console History reads "Occurred: <time>"). */
  labelFirst?: boolean;
  'data-testid'?: string;
}

export function Timeline({ items, title, labelFirst, ...rest }: TimelineProps) {
  const list = (
    <ol className="lims-timeline" {...(title ? {} : rest)}>
      {items.map((it, i) => {
        const time = (
          <time className="lims-timeline-time" dateTime={it.at}>
            {formatDateTime(it.at)}
          </time>
        );
        return (
          <li key={i} className="lims-timeline-item" data-tone={it.tone ?? 'neutral'}>
            {labelFirst ? null : <>{time}{' '}</>}
            {it.tone && it.tone !== 'neutral' ? <span className="lims-timeline-tone">{msg.toneText[it.tone]}: </span> : null}
            <span className="lims-timeline-label">{it.label}</span>
            {labelFirst ? <>{': '}{time}</> : null}
            {it.actor ? (
              <>
                {' · '}
                <span className="lims-timeline-actor">{it.actor}</span>
              </>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
  if (!title) return list;
  return (
    <div className="lims-timeline-block" {...rest}>
      <h3 className="lims-card-title">{title}</h3>
      {list}
    </div>
  );
}
