'use client';
// T0D-OFFLINE-2 (LD-322, LD-353 LIST template): the Offline panel. Three tables whose headers always show (Pending, Needs attention,
// Conflicts), Sync now, Retry, Discard with a typed reason (an audited operation sent at the next sync), the conflict inbox
// (keep_server, apply_local or field merge, both versions side by side, online only) and the PIN change.
// Personal data in the rows is masked until the user opens a row. Buttons the user cannot press are disabled and say why.
import { Fragment, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { t } from '../../i18n/messages';
import type { OfflineSnapshot } from '../controller';
import type { Operation } from '../outbox';
import { blocked, isOnline, useOfflineController, useOfflineSnapshot } from './OfflineProvider';
import { attemptsText, Modal } from './OfflineShell';

type Row = Operation & { code?: string | undefined; conflict_id?: string };
type Obj = Record<string, unknown>;
const MAX_REASON = 1000;
const PERSONAL = /name|phone|mobile|email|address/i;

const obj = (x: unknown): Obj => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Obj) : {});
const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v) ?? '');
/** every leaf of the payload as [path, value] */
const flat = (x: unknown, p = ''): Array<[string, string]> =>
  x && typeof x === 'object' ? Object.entries(x as Obj).flatMap(([k, v]) => flat(v, p ? `${p}.${k}` : k)) : [[p, show(x)]];
const mask = (v: string) => v.split(/\s+/).filter(Boolean).map((w) => `${w[0]}•••`).join(' ');
/** masked name or phone when the payload carries personal data; otherwise a short id */
function reference(r: Row) {
  const hit = flat(r.payload).find(([k, v]) => PERSONAL.test(k.split('.').pop() ?? '') && v);
  return hit ? mask(hit[1]) : (r.entity_id ?? r.op_id).slice(-8);
}
const label = (prefix: string, key: string, other: string) => { const v = t(prefix + key); return v === prefix + key ? t(other) : v; };
const typeLabel = (opType: string) => label('offline.op.', opType.split('.')[0] ?? '', 'offline.op.other');
const codeLabel = (code: string) => label('offline.code.', code, 'offline.code.other');
const time = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }); };

/** a button that is disabled with a visible reason */
function Gated({ why, onClick, children, primary, busy }: { why: { id: string; text: string | null }; onClick: () => void; children: ReactNode; primary?: boolean; busy?: boolean }) {
  return (
    <button type="button" className={`lims-btn${primary ? ' lims-btn-primary' : ''}`} disabled={why.text !== null} aria-describedby={why.text ? why.id : undefined} aria-busy={busy || undefined} onClick={onClick}>
      {children}
    </button>
  );
}
const Why = ({ why }: { why: { id: string; text: string | null } }) => (why.text ? <p id={why.id} className="lims-offline-why">{why.text}</p> : null);

function DataTable({ title, cols, empty, rows, note, cells }: { title: string; cols: string[]; empty: string; rows: Row[]; note?: ReactNode; cells: (r: Row) => ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section className="lims-offline-section">
      <h2 id={id} className="lims-offline-h2">{title}</h2>
      {note}
      <div className="lims-table-scroll">
        <table className="lims-table" aria-labelledby={id}>
          <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td colSpan={cols.length}>{empty}</td></tr> : rows.map((r) => {
              const on = open === r.op_id;
              return (
                <Fragment key={r.op_id}>
                  <tr>
                    <td>{time(r.device_created_at)}</td>
                    <td>{typeLabel(r.op_type)}</td>
                    <td>
                      <span className="lims-offline-ref">{reference(r)}</span>{' '}
                      <button type="button" className="lims-btn lims-btn-ghost" aria-expanded={on} onClick={() => setOpen(on ? null : r.op_id)}>{t(on ? 'offline.hide' : 'offline.show')}</button>
                    </td>
                    {cells(r)}
                  </tr>
                  {on ? (
                    <tr><td colSpan={cols.length}><dl className="lims-offline-fields">{flat(r.payload).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></td></tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DiscardDialog({ opId, onClose }: { opId: string; onClose: () => void }) {
  const c = useOfflineController()!;
  const id = useId();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const r = reason.trim();
  const confirm = async () => {
    if (!r || busy) return;
    setBusy(true); setErr(false);
    let ok = false;
    try { ok = (await c.discard(opId, r)).ok; } catch { ok = false; }
    setBusy(false);
    if (ok) onClose(); else setErr(true);
  };
  return (
    <Modal title={t('offline.discard.title')} onClose={onClose}>
      <p>{t('offline.discard.hint')}</p>
      <div className="lims-field"><label htmlFor={id}>{t('offline.col.reason')}</label><textarea id={id} data-autofocus className="lims-input" maxLength={MAX_REASON} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {err ? <p role="alert">{t('offline.discard.failed')}</p> : null}
      <div className="lims-dialog-footer">
        <button type="button" className="lims-btn" onClick={onClose}>{t('offline.cancel')}</button>
        <button type="button" className="lims-btn lims-btn-primary" disabled={!r || busy} onClick={confirm}>{t('offline.discard.confirm')}</button>
      </div>
    </Modal>
  );
}

type Loaded = { local: Obj; server: Obj } | null | 'loading';

function ResolveDialog({ conflictId, s, onClose }: { conflictId: string; s: OfflineSnapshot; onClose: () => void }) {
  const c = useOfflineController()!;
  const ids = { res: useId(), reason: useId(), local: useId(), server: useId(), why: useId() };
  const [data, setData] = useState<Loaded>('loading');
  const [resolution, setResolution] = useState<string | null>(null);
  const [picks, setPicks] = useState<Record<string, 'server' | 'local'>>({});
  const [reason, setReason] = useState('');
  const [alert, setAlert] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setData('loading');
    let v: Awaited<ReturnType<typeof c.loadConflict>> = null;
    try { v = await c.loadConflict(conflictId); } catch { v = null; }
    setData(v ? { local: obj(v.local_payload), server: obj(v.server_payload) } : null);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per opened conflict
  useEffect(() => { void load(); }, [conflictId]);
  const loaded = data && data !== 'loading' ? data : null;
  const differing = loaded ? [...new Set([...Object.keys(loaded.local), ...Object.keys(loaded.server)])].filter((k) => show(loaded.local[k]) !== show(loaded.server[k])) : [];
  const r = reason.trim();
  const tooLong = r.length > MAX_REASON;
  const online = isOnline(s);
  const disabled = !loaded || !resolution || !r || tooLong || !online || busy;
  const confirm = async () => {
    if (disabled || !loaded) return;
    const body: { resolution: string; reason: string; merged_payload?: unknown } = { resolution: resolution!, reason: r };
    if (resolution === 'merge') {
      const merged: Obj = { ...loaded.server };
      for (const k of differing) if (picks[k] === 'local') { if (k in loaded.local) merged[k] = loaded.local[k]; else delete merged[k]; }
      body.merged_payload = merged;
    }
    setBusy(true); setAlert(null);
    let res: { ok: boolean; code?: string } = { ok: false };
    try { res = await c.resolveConflict(conflictId, body); } catch { res = { ok: false }; }
    setBusy(false);
    if (res.ok) { onClose(); return; }
    if (res.code === 'sync.entity_changed') { setAlert(t('offline.resolve.changed')); void load(); } else setAlert(t('offline.resolve.failed'));
  };
  const side = (id: string, title: string, o: Obj) => (
    <section aria-labelledby={id} className="lims-offline-side">
      <h3 id={id} className="lims-offline-h3">{title}</h3>
      <dl className="lims-offline-fields">{Object.entries(o).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{show(v)}</dd></div>)}</dl>
    </section>
  );
  const radio = (name: string, value: string, text: string, checked: boolean, onPick: () => void) => (
    <label key={value} className="lims-offline-radio"><input type="radio" name={name} value={value} checked={checked} onChange={onPick} />{text}</label>
  );
  return (
    <Modal title={t('offline.resolve.title')} onClose={onClose} wide>
      {data === 'loading' ? null : loaded ? (
        <div className="lims-offline-sides">{side(ids.local, t('offline.resolve.local'), loaded.local)}{side(ids.server, t('offline.resolve.server'), loaded.server)}</div>
      ) : <p>{t('offline.resolve.unavailable')}</p>}
      <div role="radiogroup" aria-labelledby={ids.res} className="lims-offline-choices">
        <span id={ids.res}>{t('offline.resolve.resolution')}</span>
        {(['keep_server', 'apply_local', 'merge'] as const).map((v) => radio(ids.res, v, t(`offline.resolve.${v}`), resolution === v, () => setResolution(v)))}
      </div>
      {resolution === 'merge' && loaded ? differing.map((k) => (
        <div key={k} role="radiogroup" aria-label={k} className="lims-offline-choices">
          <span aria-hidden="true">{k}</span>
          {radio(`${ids.res}-${k}`, 'server', t('offline.resolve.pick_server'), (picks[k] ?? 'server') === 'server', () => setPicks({ ...picks, [k]: 'server' }))}
          {radio(`${ids.res}-${k}`, 'local', t('offline.resolve.pick_local'), picks[k] === 'local', () => setPicks({ ...picks, [k]: 'local' }))}
        </div>
      )) : null}
      <div className="lims-field"><label htmlFor={ids.reason}>{t('offline.col.reason')}</label><textarea id={ids.reason} className="lims-input" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      {tooLong ? <p>{t('offline.resolve.too_long')}</p> : null}
      {!online ? <p id={ids.why}>{t('offline.resolve.online_only')}</p> : null}
      {alert ? <p role="alert">{alert}</p> : null}
      <div className="lims-dialog-footer">
        <button type="button" className="lims-btn" onClick={onClose}>{t('offline.cancel')}</button>
        <button type="button" className="lims-btn lims-btn-primary" disabled={disabled} aria-describedby={!online ? ids.why : undefined} onClick={confirm}>{t('offline.resolve.title')}</button>
      </div>
    </Modal>
  );
}

function PinChange({ s }: { s: OfflineSnapshot }) {
  const c = useOfflineController()!;
  const ids = { cur: useId(), next: useId(), again: useId(), why: useId() };
  const [v, setV] = useState({ cur: '', next: '', again: '' });
  const [msg, setMsg] = useState<{ alert: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const why = { id: ids.why, text: blocked(s, 'sync.use', true) };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (why.text || busy) return;
    if (!v.cur || !v.next) { setMsg({ alert: true, text: t('offline.setup.required') }); return; }
    if (v.next !== v.again) { setMsg({ alert: true, text: t('offline.setup.mismatch') }); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await c.changePin(v.cur, v.next);
      if (r.ok) { setV({ cur: '', next: '', again: '' }); setMsg({ alert: false, text: t('offline.pin.changed') }); }
      else setMsg({ alert: true, text: r.reason === 'wrong_pin' ? attemptsText(r.attemptsLeft) : t(`offline.unlock.${r.reason === 'not_setup' ? 'failed' : r.reason}`) });
    } catch { setMsg({ alert: true, text: t('offline.unlock.failed') }); }
    setBusy(false);
  };
  const input = (k: keyof typeof v, text: string) => (
    <div className="lims-field"><label htmlFor={ids[k]}>{text}</label>
      <input id={ids[k]} type="password" inputMode="numeric" autoComplete={k === 'cur' ? 'current-password' : 'new-password'} className="lims-input" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></div>
  );
  return (
    <section className="lims-offline-section">
      <h2 className="lims-offline-h2">{t('offline.pin.title')}</h2>
      <form className="lims-form lims-offline-pin" onSubmit={submit}>
        {input('cur', t('offline.pin.current'))}{input('next', t('offline.setup.new'))}{input('again', t('offline.setup.confirm'))}
        <button type="submit" className="lims-btn lims-btn-primary" disabled={why.text !== null || busy} aria-describedby={why.text ? why.id : undefined}>{t('offline.pin.change')}</button>
      </form>
      <Why why={why} />
      {msg ? <p role={msg.alert ? 'alert' : 'status'}>{msg.text}</p> : null}
    </section>
  );
}

export function OfflinePanel() {
  const s = useOfflineSnapshot();
  const c = useOfflineController();
  const ids = { sync: useId(), use: useId(), resolve: useId() };
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  if (!s || !c) return <section className="lims-offline-page"><h1 className="lims-page-title">{t('offline.title')}</h1><p>{t('offline.unavailable')}</p></section>;
  const syncWhy = { id: ids.sync, text: blocked(s, 'sync.use') ?? (s.conn === 'syncing' ? t('offline.busy') : s.conn !== 'online' ? t('offline.need_online') : null) };
  const useWhy = { id: ids.use, text: blocked(s, 'sync.use') };
  const resolveWhy = { id: ids.resolve, text: blocked(s, 'sync.conflict.resolve') };
  const cols = (...k: string[]) => ['time', 'type', 'reference', ...k].map((x) => t(`offline.col.${x}`));
  return (
    <section className="lims-offline-page">
      <header className="lims-offline-header">
        <h1 className="lims-page-title">{t('offline.title')}</h1>
        <Gated why={syncWhy} primary busy={s.conn === 'syncing'} onClick={() => { void c.syncNow(); }}>{t('offline.sync_now')}</Gated>
      </header>
      <Why why={syncWhy} />
      <DataTable title={t('offline.pending')} cols={cols('status')} empty={t('offline.empty.pending')} rows={s.pending}
        cells={() => <td>{t('offline.status.queued')}</td>} />
      <DataTable title={t('offline.attention')} cols={cols('reason', 'action')} empty={t('offline.empty.attention')} rows={s.attention} note={<Why why={useWhy} />}
        cells={(r) => (
          <>
            <td>{codeLabel(r.code ?? '')}</td>
            <td className="lims-offline-actions">
              <Gated why={useWhy} onClick={() => { void c.retry(r.op_id).catch(() => undefined); }}>{t('offline.retry')}</Gated>
              <Gated why={useWhy} onClick={() => setDiscarding(r.op_id)}>{t('offline.discard')}</Gated>
            </td>
          </>
        )} />
      <DataTable title={t('offline.conflicts')} cols={cols('local', 'server', 'action')} empty={t('offline.empty.conflicts')} rows={s.conflicts} note={<Why why={resolveWhy} />}
        cells={(r) => (
          <>
            <td>{t('offline.cell.local')}</td>
            <td>{t('offline.cell.server')}</td>
            <td><Gated why={resolveWhy} onClick={() => setResolving(r.conflict_id ?? null)}>{t('offline.resolve')}</Gated></td>
          </>
        )} />
      <PinChange s={s} />
      {discarding ? <DiscardDialog opId={discarding} onClose={() => setDiscarding(null)} /> : null}
      {resolving ? <ResolveDialog conflictId={resolving} s={s} onClose={() => setResolving(null)} /> : null}
    </section>
  );
}
