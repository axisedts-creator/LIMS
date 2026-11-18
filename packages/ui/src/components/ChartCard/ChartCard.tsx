// T0D-UIKIT-1, LD-353 rule 10 and template 5: a chart card with a title, an optional period slot, the chart, and one note line.
// The frame ALWAYS draws its chart; with no data a "No data yet" line sits inside the frame (never a hidden chart).
import { useId, type ReactNode } from 'react';

export interface ChartCardProps {
  title: string;
  /** e.g. a PeriodPicker. */
  period?: ReactNode;
  /** One line under the chart (what is counted, freshness). */
  note?: string;
  /** The series are empty: overlays "No data yet" on the (still drawn) chart. */
  isEmpty?: boolean;
  /** A TimeSeriesChart or BarChart. */
  children: ReactNode;
  'data-testid'?: string;
}

export function ChartCard({ title, period, note, isEmpty, children, ...rest }: ChartCardProps) {
  const id = useId();
  return (
    <section className="lims-chart-card" aria-labelledby={id} {...rest}>
      <header className="lims-chart-card-header">
        <h2 id={id} className="lims-chart-card-title">{title}</h2>
        {period ? <div className="lims-chart-period">{period}</div> : null}
      </header>
      <div className="lims-chart-frame">
        {children}
        {isEmpty ? <p className="lims-chart-empty">No data yet</p> : null}
      </div>
      {note ? <p className="lims-chart-note">{note}</p> : null}
    </section>
  );
}
