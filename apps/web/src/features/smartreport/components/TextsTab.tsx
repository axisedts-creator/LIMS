'use client';
// SR-04 "Texts" (#5–#8): blocks grouped by kind, rendered as text nodes only (REQ 088/089). Drawer editor with placeholder chips and live checks.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { Select } from '@lims/ui/components/Select';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { removeAction, saveBlockAction } from '../server/actions';
import { ALLOWED_PLACEHOLDERS, BLOCK_KEY_RE, KINDS, KIND_LABEL, newKey, textProblems, type Block, type BlockKind } from '../library';
import { ErrorAlert, byField, useEditor } from './common';

// [CONV] the kit maxLength is a hard input cap; it is set above the 600 limit so an over-long paste is reported, not silently cut.
const INPUT_CAP = 2000;

export function TextsTab({ blocks }: { blocks: Block[] }) {
  const ed = useEditor();
  const router = useRouter();
  const [editing, setEditing] = useState<Block | 'new'>();
  const [removing, setRemoving] = useState<Block>();
  const [alert, setAlert] = useState<string>();
  const text = (b: Block) => (ed.language === 'ne' ? b.text_ne ?? b.text_en : b.text_en ?? b.text_ne) ?? '';

  const remove = async () => {
    if (!removing) return;
    const r = await removeAction(ed.versionId, 'block', removing.id, removing.version);
    setRemoving(undefined);
    if (r.ok) { setAlert(undefined); router.refresh(); } else setAlert(ed.failed(r));
  };

  return (
    <div>
      <ErrorAlert text={alert} />
      {ed.readOnly ? null : <Button variant="primary" onPress={() => setEditing('new')}>Add text</Button>}
      {KINDS.map((k) => {
        const list = blocks.filter((b) => b.kind === k);
        return (
          <section key={k} aria-labelledby={`kind-${k}`}>
            <h2 id={`kind-${k}`}>{KIND_LABEL[k]}</h2>
            {list.length === 0 ? <p>No blocks yet</p> : (
              <ul>
                {list.map((b) => (
                  <li key={b.id}>
                    <strong>{b.block_key}</strong> <span>{text(b)}</span>
                    {ed.readOnly ? null : (
                      <span className="lims-inline">
                        <Button size="sm" variant="ghost" onPress={() => setEditing(b)}>{`Edit ${b.block_key}`}</Button>
                        <Button size="sm" variant="ghost" onPress={() => setRemoving(b)}>{`Remove ${b.block_key}`}</Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {editing ? <BlockDrawer block={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} /> : null}
      <ConfirmDialog
        title="Remove this text?" body="Rules that use it must point to another text before submission. Earlier versions keep it." confirmLabel="Remove" tone="danger"
        isOpen={!!removing} onCancel={() => setRemoving(undefined)} onConfirm={remove}
      />
    </div>
  );
}

function BlockDrawer({ block, onClose }: { block?: Block | undefined; onClose: () => void }) {
  const ed = useEditor();
  const router = useRouter();
  const [key, setKey] = useState(block?.block_key ?? '');
  const [kind, setKind] = useState<BlockKind | undefined>(block?.kind);
  const [en, setEn] = useState(block?.text_en ?? '');
  const [ne, setNe] = useState(block?.text_ne ?? '');
  const [note, setNote] = useState(block?.note ?? '');
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Record<string, string>>({});
  const [alert, setAlert] = useState<string>();
  const lastText = useRef<'en' | 'ne'>(ed.language);
  const idem = useRef(newKey());

  const req = (field: 'en' | 'ne') => ed.language === field;
  const errs: Record<string, string | undefined> = {
    block_key: tried && !BLOCK_KEY_RE.test(key) ? (key ? 'Key is invalid: lowercase letters, digits, "_" and "." (3–80, starting with a letter).' : 'Key is required.') : undefined,
    kind: tried && !kind ? 'Kind is required.' : undefined,
    text_en: [...(tried && req('en') && !en.trim() ? ['English text is required.'] : []), ...textProblems(en, kind, 'English text')].join(' ') || undefined,
    text_ne: [...(tried && req('ne') && !ne.trim() ? ['Nepali text is required.'] : []), ...textProblems(ne, kind, 'Nepali text')].join(' ') || undefined,
    note: note.length > 500 ? 'Author note must be 500 characters or fewer.' : undefined,
  };
  const shown = (f: string) => errs[f] ?? server[f];

  const insert = (p: string) => {
    const t = `{${p}}`;
    if (lastText.current === 'ne') setNe((s) => s + t); else setEn((s) => s + t);
  };

  const save = async () => {
    setTried(true);
    setServer({});
    const now = {
      block_key: !BLOCK_KEY_RE.test(key), kind: !kind, en: (req('en') && !en.trim()) || textProblems(en, kind, '').length > 0,
      ne: (req('ne') && !ne.trim()) || textProblems(ne, kind, '').length > 0, note: note.length > 500,
    };
    if (Object.values(now).some(Boolean)) return;
    const body = { block_key: key, kind: kind!, ...(en ? { text_en: en } : {}), ...(ne ? { text_ne: ne } : {}), ...(note ? { note } : {}) };
    const r = await saveBlockAction(ed.versionId, body, block ? { blockId: block.id, version: block.version } : { key: idem.current });
    if (r.ok) { onClose(); router.refresh(); return; }
    setAlert(ed.failed(r));
    setServer(byField(r.errors));
  };

  const chips = kind ? ALLOWED_PLACEHOLDERS[kind] : [];
  const err = (f: string) => { const e = shown(f); return e ? { error: e } : {}; };
  return (
    <Drawer title={block ? `Edit text ${block.block_key}` : 'Add text'} isOpen onClose={onClose}>
      <ErrorAlert text={alert} />
      <Form onSubmit={save} errorSummary={false}>
        <TextField label="Key" name="block_key" maxLength={80} value={key} onChange={setKey} isReadOnly={!!block} {...err('block_key')} />
        <Select<BlockKind> label="Kind" name="kind" options={KINDS.map((k) => ({ value: k, label: `${KIND_LABEL[k]} (${k})` }))} {...(kind ? { value: kind } : {})} isReadOnly={!!block} onChange={setKind} {...err('kind')} />
        <div onFocus={() => { lastText.current = 'en'; }}>
          <TextArea label="English text" name="text_en" maxLength={INPUT_CAP} value={en} onChange={setEn} {...err('text_en')} />
        </div>
        <div ref={(el) => el?.querySelector('textarea')?.setAttribute('lang', 'ne')} onFocus={() => { lastText.current = 'ne'; }}>
          <TextArea label="Nepali text" name="text_ne" maxLength={INPUT_CAP} value={ne} onChange={setNe} {...err('text_ne')} />
        </div>
        <div>
          <p id="chips-label">{chips.length ? 'Allowed placeholders (click to insert):' : 'This kind has no placeholders.'}</p>
          <span className="lims-inline" role="group" aria-labelledby="chips-label">
            {chips.map((p) => <Button key={p} size="sm" onPress={() => insert(p)}>{`{${p}}`}</Button>)}
          </span>
        </div>
        <TextArea label="Author note (not printed)" name="note" maxLength={INPUT_CAP} showCount={false} value={note} onChange={setNote} {...err('note')} />
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
