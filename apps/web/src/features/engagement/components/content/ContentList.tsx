'use client';
// T0D-CONTENT-1 one list tab (News, Banners or Offers; LD-353 template 1): New button, DataTable with the header always drawn, Active switch,
// start and end dates, sort order with Move up / Move down, Edit form in a dialog. Switching off is deactivatePortalContent (never a delete);
// every write carries If-Match = the row's version, and a 409 keeps the form open (no silent overwrite).
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { DataTable } from '@lims/ui/components/DataTable';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DateText } from '@lims/ui/components/DateText';
import { Dialog } from '@lims/ui/components/Dialog';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { t } from '@/core/i18n/messages';
import { createContentAction, deactivateContentAction, reorderContentAction, updateContentAction } from '../../server/content-actions';
import { ImageField, Thumb } from './ImageField';
import { MarkdownEditor } from './MarkdownEditor';
import { TITLE_MAX, LINK_MAX, bodyError, failText, linkError, titleError, windowError, type ContentFields, type PortalContent } from './content-model';

export type ListKind = 'news' | 'banner' | 'offer';
type Setter = (fn: (all: PortalContent[]) => PortalContent[]) => void;

export const byOrder = (a: PortalContent, b: PortalContent) => a.sort_order - b.sort_order || (a.created_at ?? '').localeCompare(b.created_at ?? '');

function ItemDialog({ kind, item, canUpload, onClose, onSaved }: { kind: ListKind; item?: PortalContent | undefined; canUpload: boolean; onClose: () => void; onSaved: (p: PortalContent) => void }) {
  const [title, setTitle] = useState(item?.title ?? '');
  const [body, setBody] = useState(item?.body ?? '');
  const [link, setLink] = useState(item?.link_url ?? '');
  const [image, setImage] = useState(item?.image_attachment_id);
  const [starts, setStarts] = useState(item?.starts_on as IsoDate | undefined); // contract format: date
  const [ends, setEnds] = useState(item?.ends_on as IsoDate | undefined);
  const [active, setActive] = useState(item?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const isBanner = kind === 'banner';

  const save = async () => {
    if (busy) return;
    const e = {
      title: titleError(title),
      body: isBanner ? undefined : bodyError(body),
      link: isBanner ? linkError(link) : undefined,
      image: isBanner && !image ? t('engagement.content.error.image_required') : undefined,
      ends: windowError(starts, ends),
    };
    setErrors(e);
    if (Object.values(e).some(Boolean)) return;
    const next: ContentFields = {
      title,
      ...(!isBanner ? { body } : {}),
      ...(isBanner && link ? { link_url: link } : {}),
      ...(isBanner && image ? { image_attachment_id: image } : {}),
      ...(starts ? { starts_on: starts } : {}),
      ...(ends ? { ends_on: ends } : {}),
    };
    let r;
    if (item) {
      // only the changed fields (PortalContentUpdate is partial; the contract cannot unset a field)
      const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => item[k as keyof PortalContent] !== v)) as ContentFields;
      if (active !== item.is_active) diff.is_active = active;
      if (Object.keys(diff).length === 0) { onClose(); return; }
      setBusy(true);
      r = await updateContentAction(item.id, item.version, diff);
    } else {
      setBusy(true);
      r = await createContentAction({ kind, ...next });
    }
    setBusy(false);
    if (r.ok) onSaved(r.data);
    else setFailure(failText(r));
  };

  return (
    <Dialog
      title={t(`engagement.content.${item ? 'edit' : 'new'}.${kind}`)}
      isOpen
      onClose={onClose}
      size="md"
      footer={<><Button variant="ghost" onPress={onClose}>{t('engagement.content.form.cancel')}</Button><Button variant="primary" isLoading={busy} onPress={() => void save()}>{t('engagement.content.form.save')}</Button></>}
    >
      <div className="lims-stack">
        <TextField label={t('engagement.content.field.title')} name="title" isRequired maxLength={TITLE_MAX} value={title} onChange={setTitle} {...(errors['title'] ? { error: errors['title'] } : {})} />
        {isBanner ? (
          <>
            <TextField label={t('engagement.content.field.link')} name="link_url" maxLength={LINK_MAX} value={link} onChange={setLink} {...(errors['link'] ? { error: errors['link'] } : {})} />
            {image ? <Thumb assetId={image} alt={t('engagement.content.upload.alt')} /> : null}
            <ImageField name="image" canUpload={canUpload} error={errors['image']} onUploaded={setImage} />
          </>
        ) : (
          <MarkdownEditor value={body} onChange={setBody} />
        )}
        <div className="lims-inline">
          <DatePicker label={t('engagement.content.field.starts')} name="starts_on" value={starts} onChange={setStarts} />
          <DatePicker label={t('engagement.content.field.ends')} name="ends_on" value={ends} onChange={setEnds} {...(errors['ends'] ? { error: errors['ends'] } : {})} />
        </div>
        <p className="lims-description">
          {starts || ends ? (
            <>{t('engagement.content.form.window')} {starts ? <DateText value={starts} /> : null} {ends ? <>{t('engagement.content.form.to')} <DateText value={ends} /></> : null}</>
          ) : t('engagement.content.form.always')}
        </p>
        {item ? <Switch label={t('engagement.content.field.active')} isSelected={active} onChange={setActive} /> : null}
        {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      </div>
    </Dialog>
  );
}

export function ContentList({ kind, items, canManage, canUpload, today, setItems }: { kind: ListKind; items: readonly PortalContent[]; canManage: boolean; canUpload: boolean; today: string; setItems: Setter }) {
  const router = useRouter();
  const rows = items.filter((i) => i.kind === kind).sort(byOrder);
  const [editing, setEditing] = useState<PortalContent | 'new' | undefined>();
  const [failure, setFailure] = useState<string>();
  const put = (p: PortalContent) => setItems((all) => (all.some((x) => x.id === p.id) ? all.map((x) => (x.id === p.id ? p : x)) : [...all, p]));

  const toggle = async (it: PortalContent, on: boolean) => {
    put({ ...it, is_active: on }); // optimistic; put back on failure
    const r = on ? await updateContentAction(it.id, it.version, { is_active: true }) : await deactivateContentAction(it.id, it.version);
    if (r.ok) { put({ ...it, is_active: r.data.is_active ?? on, version: r.data.version ?? it.version }); setFailure(undefined); router.refresh(); }
    else { put(it); setFailure(failText(r)); }
  };

  const move = async (from: number, to: number) => {
    const order = rows.map((r) => r.id);
    [order[from], order[to]] = [order[to]!, order[from]!];
    const pos = new Map(order.map((id, i) => [id, i]));
    setItems((all) => all.map((x) => (pos.has(x.id) ? { ...x, sort_order: pos.get(x.id)! } : x)));
    const r = await reorderContentAction(kind, order);
    if (r.ok) {
      const fresh = r.data.data ?? [];
      if (fresh.length === order.length) setItems((all) => all.map((x) => fresh.find((f) => f.id === x.id) ?? x));
      setFailure(undefined);
      router.refresh();
    } else {
      setItems((all) => all.map((x) => rows.find((o) => o.id === x.id) ?? x));
      setFailure(failText(r));
    }
  };

  const date = (d?: string) => (d ? <DateText value={d as IsoDate} /> : '—');
  return (
    <div className="lims-stack">
      {canManage ? (
        <div className="lims-inline lims-justify-end">
          <Button variant="primary" onPress={() => setEditing('new')}>{t(`engagement.content.new.${kind}`)}</Button>
        </div>
      ) : null}
      {failure ? <p role="alert" className="lims-error">{failure}</p> : null}
      <DataTable
        caption={t(`engagement.content.tab.${kind}`)}
        density="compact"
        cellTitle
        rows={rows}
        getRowId={(r) => r.id}
        emptyState={{ title: t(`engagement.content.empty.${kind}`), body: t('engagement.content.empty.hint') }}
        columns={[
          { id: 'title', header: t('engagement.content.col.title'), isRowHeader: true, cell: (r) => <><span title={r.title}>{r.title}</span>{' '}</> }, // title = full text on a cut off cell (rule 5); the space keeps the row text readable
          ...(kind === 'banner' ? [{ id: 'image', header: t('engagement.content.field.image'), cell: (r: PortalContent) => (r.image_attachment_id ? <Thumb assetId={r.image_attachment_id} alt={r.title} /> : '—') }] : []),
          { id: 'active', header: t('engagement.content.col.active'), cell: (r) => <Switch label={t('engagement.content.field.active')} isSelected={r.is_active} isDisabled={!canManage} onChange={(on) => void toggle(r, on)} /> },
          { id: 'starts', header: t('engagement.content.col.starts'), cell: (r) => date(r.starts_on) },
          { id: 'ends', header: t('engagement.content.col.ends'), cell: (r) => (r.ends_on && r.ends_on < today ? <>{date(r.ends_on)} {t('engagement.content.row.ended')}</> : date(r.ends_on)) },
          {
            id: 'order', header: t('engagement.content.col.order'), numeric: true, cell: (r) => {
              const i = rows.indexOf(r);
              return (
                <span className="lims-inline">
                  {i + 1}
                  {canManage ? (
                    <>
                      <Button size="sm" variant="ghost" iconStart="arrow-up" isDisabled={i === 0} onPress={() => void move(i, i - 1)}><VisuallyHidden>{t('engagement.content.row.up')}</VisuallyHidden></Button>
                      <Button size="sm" variant="ghost" iconStart="arrow-down" isDisabled={i === rows.length - 1} onPress={() => void move(i, i + 1)}><VisuallyHidden>{t('engagement.content.row.down')}</VisuallyHidden></Button>
                    </>
                  ) : null}
                </span>
              );
            },
          },
          ...(canManage ? [{ id: 'actions', header: t('engagement.content.col.actions'), cell: (r: PortalContent) => <Button size="sm" variant="ghost" onPress={() => setEditing(r)}>{t('engagement.content.row.edit')}</Button> }] : []),
        ]}
      />
      {editing ? (
        <ItemDialog
          kind={kind}
          item={editing === 'new' ? undefined : editing}
          canUpload={canUpload}
          onClose={() => setEditing(undefined)}
          onSaved={(p) => { put(p); setEditing(undefined); router.refresh(); }}
        />
      ) : null}
    </div>
  );
}
