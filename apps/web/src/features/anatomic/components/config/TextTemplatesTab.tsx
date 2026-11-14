'use client';
// 04-UI-UX §4.7 Text templates tab (K20/K21/K22): table Short code · Section · Title · Active; Drawer: Short code (create only, ^[a-z0-9_]{1,16}$), Section (create only), Title (<=120),
// Body (counted TextArea <=8000), Active (edit only). Create: POST + Idempotency-Key; edit: PUT {title, body, is_active} with If-Match = the template version.
// Template text is shown as text, never HTML (REQ-SEC-088). LD-140 (2026-11-13, binding): kit components only; [Add template] is the page's one primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createTextTemplateAction, updateTextTemplateAction } from '../../server/actions.config';
import type { TextSection, TextTemplateRecord } from '../../server/config.types';
import { FormDialog } from '../material/FormDialog';
import { ActiveChip, cfgText, MasterList, MfaDialog, newKey } from './config-shared';

const SECTIONS: readonly { value: TextSection; label: string }[] = [
  { value: 'gross', label: 'Gross' }, { value: 'microscopy', label: 'Microscopy' }, { value: 'impression', label: 'Impression' }, { value: 'comment', label: 'Comment' }, { value: 'addendum', label: 'Addendum' },
];
const label = (s: string) => SECTIONS.find((x) => x.value === s)?.label ?? s;
const SHORT = /^[a-z0-9_]{1,16}$/;

export function TextTemplatesTab({ items }: { items: readonly TextTemplateRecord[] }) {
  const [editing, setEditing] = useState<TextTemplateRecord | 'new'>();
  const [mfa, setMfa] = useState(false);
  return (
    <>
      <MasterList empty={items.length === 0} title="No text templates yet." addLabel="Add template" onAdd={() => setEditing('new')}>
        <DataTable
          caption="Text templates"
          density="compact"
          rows={items}
          getRowId={(t) => t.id}
          emptyState={{ title: 'No text templates yet.' }}
          columns={[
            { id: 'code', header: 'Short code', isRowHeader: true, cell: (t) => <span className="lims-mono">{t.short_code}</span> },
            { id: 'section', header: 'Section', cell: (t) => label(t.section) },
            { id: 'title', header: 'Title', cell: (t) => t.title },
            { id: 'active', header: 'Active', cell: (t) => <ActiveChip active={t.is_active} /> },
            { id: 'edit', header: 'Actions', cell: (t) => <Button size="sm" variant="ghost" onPress={() => setEditing(t)}>{`Edit ${t.short_code}`}</Button> },
          ]}
        />
      </MasterList>
      {editing ? <TemplateDrawer item={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onMfa={() => { setEditing(undefined); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

function TemplateDrawer({ item, onClose, onMfa }: { item: TextTemplateRecord | undefined; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [short, setShort] = useState(item?.short_code ?? '');
  const [section, setSection] = useState<TextSection | undefined>(item?.section as TextSection | undefined);
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [active, setActive] = useState(item?.is_active ?? true);
  const [shortError, setShortError] = useState<string>();
  const [sectionError, setSectionError] = useState<string>();
  return (
    <FormDialog
      as="drawer"
      title={item ? 'Edit text template' : 'Add text template'}
      submitLabel="Save"
      describe={cfgText}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!item) {
          setShortError(SHORT.test(short) ? undefined : 'Use lower case letters, digits and underscore, 16 at most.');
          setSectionError(section ? undefined : 'Choose a section.');
          if (!SHORT.test(short) || !section) return undefined;
        }
        const r = item
          ? await updateTextTemplateAction(item.id, item.version, { title, body, is_active: active })
          : await createTextTemplateAction({ short_code: short, section: section!, title, body }, newKey());
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Saved' });
        onClose();
        router.refresh();
        return undefined;
      }}
    >
      <TextField label="Short code" name="short_code" isRequired maxLength={16} value={short} onChange={setShort} {...(item ? { isReadOnly: true } : {})} {...(shortError ? { error: shortError } : {})} />
      {item ? (
        <TextField label="Section" name="section_fixed" maxLength={16} value={label(item.section)} isReadOnly />
      ) : (
        <Select label="Section" name="section" isRequired options={SECTIONS} {...(section ? { value: section } : {})} onChange={setSection} {...(sectionError ? { error: sectionError } : {})} />
      )}
      <TextField label="Title" name="title" isRequired maxLength={120} value={title} onChange={setTitle} />
      <TextArea label="Body" name="body" isRequired maxLength={8000} rows={8} value={body} onChange={setBody} />
      {item ? <Switch label="Active" name="is_active" isSelected={active} onChange={setActive} /> : null}
    </FormDialog>
  );
}
