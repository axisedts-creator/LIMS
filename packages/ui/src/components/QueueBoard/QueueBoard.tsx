import { useEffect, useRef, useState } from 'react';
import { DEFAULT_TZ, utcParts, type IsoUtc } from '../_shared/dates';

export type { IsoUtc };

export interface QueueBoardProps {
  title: string;
  subtitle?: string;
  nowCalling: { token: string; counter: string; queue: string; isNew: boolean }[];
  waiting: { queue: string; count: number }[];
  serverTime: IsoUtc;
  connection: 'live' | 'stale' | 'unpaired';
  staleSince?: IsoUtc;
  soundEnabled: boolean;
}

const MAX_ROWS = 5;
const FLASH_MS = 3_000;

// [CONV] LD-140/LD-145: kit tokens only. Token text >= 96 px = 4 x the 2xl type token (24 px), growing with the TV height (D1: vh units).
// React 19 hoists this <style> into <head>.
const CSS = `
.lims-queueboard { box-sizing: border-box; height: 100vh; overflow: hidden; display: grid; grid-template-rows: auto 1fr auto;
  grid-template-columns: 3fr 1fr; gap: var(--lims-space-4); padding: var(--lims-space-6);
  font-family: var(--lims-font-family-sans); color: var(--lims-neutral-900); background: var(--lims-neutral-0); }
.lims-queueboard h1, .lims-queueboard h2, .lims-queueboard p, .lims-queueboard ol, .lims-queueboard ul { margin: 0; padding: 0; list-style: none; }
.lims-queueboard__header { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; gap: var(--lims-space-4); }
.lims-queueboard__title { font-size: max(var(--lims-font-size-3xl-size), 5vh); font-weight: var(--lims-font-weight-bold); }
.lims-queueboard__subtitle, .lims-queueboard__clock { font-size: max(var(--lims-font-size-2xl-size), 3.5vh); }
.lims-queueboard__clock { font-family: var(--lims-font-family-mono); font-variant-numeric: tabular-nums; }
.lims-queueboard__section-title { font-size: max(var(--lims-font-size-2xl-size), 4vh); font-weight: var(--lims-font-weight-semibold); margin-bottom: var(--lims-space-2); }
.lims-queueboard__row { display: flex; align-items: baseline; gap: var(--lims-space-4); padding: var(--lims-space-2) var(--lims-space-3);
  border: 1px solid var(--lims-neutral-300); margin-bottom: var(--lims-space-2); }
.lims-queueboard__token { font-family: var(--lims-font-family-mono); font-weight: var(--lims-font-weight-bold);
  font-size: max(calc(var(--lims-font-size-2xl-size) * 4), 12vh); line-height: 1; }
.lims-queueboard__counter { font-size: max(var(--lims-font-size-3xl-size), 6vh); font-weight: var(--lims-font-weight-semibold); }
.lims-queueboard__row--flash { animation: lims-queueboard-flash 0.5s steps(2) 6; border-width: 4px; }
@keyframes lims-queueboard-flash { 50% { background: var(--lims-neutral-900); color: var(--lims-neutral-0); } }
.lims-queueboard__waiting li { display: flex; justify-content: space-between; font-size: max(var(--lims-font-size-2xl-size), 4vh);
  padding: var(--lims-space-2) 0; border-bottom: 1px solid var(--lims-neutral-300); }
.lims-queueboard__count { font-weight: var(--lims-font-weight-bold); font-variant-numeric: tabular-nums; }
.lims-queueboard__footer { grid-column: 1 / -1; text-align: center; font-size: max(var(--lims-font-size-2xl-size), 4vh); }
.lims-queueboard__banner { grid-column: 1 / -1; padding: var(--lims-space-2) var(--lims-space-3); border: 2px solid var(--lims-tone-warning-border);
  background: var(--lims-tone-warning-bg); color: var(--lims-tone-warning-fg); font-size: max(var(--lims-font-size-xl-size), 3vh); }
.lims-queueboard__unpaired { grid-column: 1 / -1; align-self: center; text-align: center; }
@media (prefers-reduced-motion: reduce) { .lims-queueboard__row--flash { animation: none; } }`;

const clockFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const clockText = (ms: number) => (Number.isFinite(ms) ? clockFmt.format(ms) : '');

/** Short chime via Web Audio (LD-145: the repo has no audio asset). */
function chime(ref: { current: AudioContext | undefined }) {
  const g = globalThis as any;
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return;
  try {
    const ctx: AudioContext = (ref.current ??= new Ctor());
    void ctx.resume?.();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    // audio is best-effort; the flash still marks the new token
  }
}

/** Full-screen queue board for the paired TV (CR-C16-016; C16 04-UI-UX §9.2, D1; LD-145). Tokens and counters only — never patient data. */
export function QueueBoard({ title, subtitle, nowCalling, waiting, serverTime, connection, staleSince, soundEnabled }: QueueBoardProps) {
  // Clock: starts at serverTime, advanced locally every second until the next poll brings a new serverTime.
  const [ticks, setTicks] = useState(0);
  useEffect(() => {
    setTicks(0);
    const id = setInterval(() => setTicks((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [serverTime]);

  // Flash each isNew token once for 3 s (and chime if the operator enabled sound).
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const flashed = useRef(new Set<string>());
  const audio = useRef<AudioContext | undefined>(undefined);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const rows = nowCalling.slice(0, MAX_ROWS);
  const newKey = rows.filter((r) => r.isNew).map((r) => r.token).join('\n');
  useEffect(() => {
    const current = newKey ? newKey.split('\n') : [];
    const fresh = current.filter((t) => !flashed.current.has(t));
    flashed.current = new Set(current); // only remember tokens still marked new, so a reused label (next day) flashes again
    if (!fresh.length) return;
    setFlashing((s) => new Set([...s, ...fresh]));
    if (soundEnabled) chime(audio);
    const id = setTimeout(() => {
      timers.current.delete(id);
      setFlashing((s) => new Set([...s].filter((t) => !fresh.includes(t))));
    }, FLASH_MS);
    timers.current.add(id);
  }, [newKey, soundEnabled]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      void audio.current?.close?.();
    },
    [],
  );

  const lastUpdate = staleSince ? utcParts(staleSince, DEFAULT_TZ)?.time : undefined;

  return (
    <main className="lims-queueboard" data-testid="queue-board" data-connection={connection}>
      <style href="lims-queueboard" precedence="default">{CSS}</style>
      <header className="lims-queueboard__header">
        <div>
          <h1 className="lims-queueboard__title">{title}</h1>
          {subtitle && <p className="lims-queueboard__subtitle">{subtitle}</p>}
        </div>
        <time className="lims-queueboard__clock" dateTime={serverTime}>
          {clockText(Date.parse(serverTime) + ticks * 1_000)}
        </time>
      </header>
      {connection === 'unpaired' ? (
        <section className="lims-queueboard__unpaired">
          <h2 className="lims-queueboard__section-title">Not paired</h2>
          <p>Ask a lab administrator to pair this screen</p>
        </section>
      ) : (
        <>
          {connection === 'stale' && (
            <p role="status" className="lims-queueboard__banner">
              Connection lost — showing last update at {lastUpdate ?? staleSince ?? ''}
            </p>
          )}
          <section aria-labelledby="lims-queueboard-now">
            <h2 id="lims-queueboard-now" className="lims-queueboard__section-title">Now calling</h2>
            <ol>
              {rows.map((r) => {
                const on = flashing.has(r.token);
                return (
                  <li key={r.token} className={`lims-queueboard__row${on ? ' lims-queueboard__row--flash' : ''}`} data-new={on ? 'true' : undefined}>
                    <span className="lims-queueboard__token">{r.token}</span>
                    <span className="lims-queueboard__counter">→ {r.counter}</span>
                  </li>
                );
              })}
            </ol>
          </section>
          <section aria-labelledby="lims-queueboard-waiting" className="lims-queueboard__waiting">
            <h2 id="lims-queueboard-waiting" className="lims-queueboard__section-title">Waiting</h2>
            <ul>
              {waiting.map((w) => (
                <li key={w.queue}>
                  <span>{w.queue}</span>
                  <span className="lims-queueboard__count">{w.count}</span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
      <footer className="lims-queueboard__footer">Please keep your token slip</footer>
    </main>
  );
}
