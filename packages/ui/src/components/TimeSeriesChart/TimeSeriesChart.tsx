// Results trend (00 C7, 04-UI-UX §2.5): in-house SVG, straight segments between the values as given, plus a hidden data table (CV §14).
import { useId } from 'react';
import { formatDateTime } from '../_shared/time';

export interface TimeSeriesChartProps {
  title: string;
  series: readonly { id: string; label: string; points: readonly { at: string; value: string }[] }[];
  referenceBand?: { low?: string; high?: string };
  unit?: string;
  /** px, default 240. */
  height?: number;
  'data-testid'?: string;
}

const W = 600;
const M = { l: 56, r: 12, t: 12, b: 28 };
const DASH = ['', '6 3', '2 3', '8 3 2 3', '1 2', '10 4'];
const num = (s: string | undefined) => (s === undefined ? NaN : Number(s));
const fin = (n: number) => Number.isFinite(n);
const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

function scale(lo: number, hi: number, a: number, b: number) {
  if (!fin(lo) || !fin(hi)) [lo, hi] = [0, 1];
  if (lo === hi) [lo, hi] = [lo - 1, hi + 1];
  return (v: number) => a + ((v - lo) / (hi - lo)) * (b - a);
}

export function TimeSeriesChart({ title, series, referenceBand, unit, height = 240, ...rest }: TimeSeriesChartProps) {
  const id = useId();
  const H = Math.max(80, height);
  const pts = series.flatMap((s) => s.points).filter((p) => fin(num(p.value)) && fin(Date.parse(p.at)));
  const vals = [...pts.map((p) => num(p.value)), num(referenceBand?.low), num(referenceBand?.high)].filter(fin);
  const times = pts.map((p) => Date.parse(p.at));
  const y = scale(Math.min(...vals), Math.max(...vals), H - M.b, M.t);
  const x = scale(Math.min(...times), Math.max(...times), M.l, W - M.r);
  const yMin = vals.length ? Math.min(...vals) : undefined;
  const yMax = vals.length ? Math.max(...vals) : undefined;
  const u = unit ? ` ${unit}` : '';

  const lo = num(referenceBand?.low);
  const hi = num(referenceBand?.high);
  const band = fin(lo) || fin(hi) ? { top: fin(hi) ? y(hi) : M.t, bottom: fin(lo) ? y(lo) : H - M.b } : undefined;

  const rowsAt = [...new Set(series.flatMap((s) => s.points.map((p) => p.at)))].sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0));
  const day = (at: string) => formatDateTime(at);

  return (
    <figure className="lims-chart" {...rest}>
      <figcaption id={`${id}-t`} className="lims-chart-title">
        {title}
      </figcaption>
      <svg role="img" aria-labelledby={`${id}-t`} viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="lims-chart-svg">
        {band ? <rect className="lims-chart-band" x={M.l} y={f1(band.top)} width={W - M.l - M.r} height={f1(Math.max(0, band.bottom - band.top))} /> : null}
        <line className="lims-chart-axis" x1={M.l} y1={H - M.b} x2={W - M.r} y2={H - M.b} />
        <line className="lims-chart-axis" x1={M.l} y1={M.t} x2={M.l} y2={H - M.b} />
        {yMax !== undefined ? (
          <text className="lims-chart-tick" x={M.l - 4} y={f1(y(yMax))} textAnchor="end">
            {String(yMax)}
          </text>
        ) : null}
        {yMin !== undefined && yMin !== yMax ? (
          <text className="lims-chart-tick" x={M.l - 4} y={f1(y(yMin))} textAnchor="end">
            {String(yMin)}
          </text>
        ) : null}
        {unit ? (
          <text className="lims-chart-unit" x={4} y={M.t + 4}>
            {unit}
          </text>
        ) : null}
        {times.length ? (
          <>
            <text className="lims-chart-tick" x={M.l} y={H - 8}>
              {day(new Date(Math.min(...times)).toISOString()).slice(0, 10)}
            </text>
            <text className="lims-chart-tick" x={W - M.r} y={H - 8} textAnchor="end">
              {day(new Date(Math.max(...times)).toISOString()).slice(0, 10)}
            </text>
          </>
        ) : null}
        {series.map((s, i) => {
          const p = s.points.filter((q) => fin(num(q.value)) && fin(Date.parse(q.at)));
          if (!p.length) return null;
          const d = p.map((q, j) => `${j ? 'L' : 'M'}${f1(x(Date.parse(q.at)))} ${f1(y(num(q.value)))}`).join(' ');
          return (
            <g key={s.id} className={`lims-chart-series lims-series-${i % DASH.length}`}>
              <path d={d} fill="none" stroke="currentColor" strokeWidth={2} {...(DASH[i % DASH.length] ? { strokeDasharray: DASH[i % DASH.length] } : {})} />
              {p.map((q, j) => (
                <circle key={j} cx={f1(x(Date.parse(q.at)))} cy={f1(y(num(q.value)))} r={3} fill="currentColor" />
              ))}
            </g>
          );
        })}
      </svg>
      {series.length ? (
        <ul className="lims-chart-legend">
          {series.map((s, i) => (
            <li key={s.id} className={`lims-series-${i % DASH.length}`}>
              <svg aria-hidden="true" width="24" height="8">
                <line x1="0" y1="4" x2="24" y2="4" stroke="currentColor" strokeWidth="2" {...(DASH[i % DASH.length] ? { strokeDasharray: DASH[i % DASH.length] } : {})} />
              </svg>
              <span>{s.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {referenceBand && (referenceBand.low || referenceBand.high) ? (
        <p className="lims-chart-note">
          Reference range: {referenceBand.low ?? '—'} – {referenceBand.high ?? '—'}
          {u}
        </p>
      ) : null}
      <div className="lims-visually-hidden">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              {series.map((s) => (
                <th key={s.id} scope="col">
                  {s.label}
                  {u}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowsAt.map((at) => (
              <tr key={at}>
                <th scope="row">{day(at)}</th>
                {series.map((s) => {
                  const v = s.points.filter((p) => p.at === at).map((p) => p.value);
                  return <td key={s.id}>{v.length ? v.join(', ') : '—'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
