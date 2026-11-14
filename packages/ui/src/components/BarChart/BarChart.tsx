// In-house SVG bar chart (04-UI-UX §2.5): bars start at zero; a hidden data table carries the same numbers (CV §14).
import { useId } from 'react';
import { formatPaisa } from '../_shared/decimal';

export interface BarChartProps {
  title: string;
  categories: readonly string[];
  series: readonly { id: string; label: string; values: readonly number[] }[];
  /** 'money' = values in paisa ([CONV] Money.amountPaisa), shown as Rs.; 'integer' = lakh grouping. */
  valueFormat?: 'integer' | 'money';
  'data-testid'?: string;
}

const W = 600;
const H = 240;
const M = { l: 56, r: 12, t: 12, b: 36 };
const PATTERN = ['solid', 'hatch', 'dots', 'cross'] as const;
const fin = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();
const INT = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export function BarChart({ title, categories, series, valueFormat, ...rest }: BarChartProps) {
  const id = useId();
  const fmt = (v: number) => (valueFormat === 'money' ? `Rs. ${formatPaisa(v)}` : valueFormat === 'integer' ? INT.format(v) : String(v));
  const vals = series.flatMap((s) => s.values.slice(0, categories.length)).filter(fin);
  let hi = Math.max(0, ...vals);
  const lo = Math.min(0, ...vals);
  if (hi === lo) hi = lo + 1;
  const y = (v: number) => M.t + ((hi - v) / (hi - lo)) * (H - M.t - M.b);
  const group = (W - M.l - M.r) / Math.max(1, categories.length);
  const bar = (group * 0.8) / Math.max(1, series.length);

  return (
    <figure className="lims-chart" {...rest}>
      <figcaption id={`${id}-t`} className="lims-chart-title">
        {title}
      </figcaption>
      <svg role="img" aria-labelledby={`${id}-t`} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="lims-chart-svg">
        <line className="lims-chart-axis" x1={M.l} y1={f1(y(0))} x2={W - M.r} y2={f1(y(0))} />
        <text className="lims-chart-tick" x={M.l - 4} y={f1(y(hi))} textAnchor="end">
          {fmt(hi)}
        </text>
        {lo < 0 ? (
          <text className="lims-chart-tick" x={M.l - 4} y={f1(y(lo))} textAnchor="end">
            {fmt(lo)}
          </text>
        ) : null}
        {categories.map((c, ci) => (
          <g key={ci}>
            {series.map((s, si) => {
              const v = s.values[ci];
              if (!fin(v)) return null;
              const top = Math.min(y(v), y(0));
              return (
                <rect
                  key={s.id}
                  className={`lims-chart-bar lims-series-${si % 6} lims-pattern-${PATTERN[si % PATTERN.length]}`}
                  x={f1(M.l + ci * group + group * 0.1 + si * bar)}
                  y={f1(top)}
                  width={f1(bar)}
                  height={Math.abs(y(v) - y(0))}
                  fill="currentColor"
                />
              );
            })}
            <text className="lims-chart-tick" x={f1(M.l + ci * group + group / 2)} y={H - 12} textAnchor="middle">
              {c}
            </text>
          </g>
        ))}
      </svg>
      {series.length ? (
        <ul className="lims-chart-legend">
          {series.map((s, i) => (
            <li key={s.id} className={`lims-series-${i % 6} lims-pattern-${PATTERN[i % PATTERN.length]}`}>
              <span className="lims-chart-swatch" aria-hidden="true" />
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="lims-visually-hidden">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Category</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((c, ci) => (
              <tr key={ci}>
                <th scope="row">{c}</th>
                {series.map((s) => {
                  const v = s.values[ci];
                  return <td key={s.id}>{fin(v) ? fmt(v) : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
