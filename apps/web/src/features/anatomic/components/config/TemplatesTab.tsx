'use client';
// 04-UI-UX §4.7 Synoptic templates tab (K13, K17-K19; AC-08.3, AC-08.4): table Key · Version · Title · Status · Case kinds · Published. [New template] opens the blank builder; the key
// opens the editor. Actions follow the status: draft -> Publish; published -> New version and Retire; retired -> none. Publish and Retire ask in a ConfirmDialog first; the action reads
// the current row version itself (list rows carry none) for If-Match. [New version] POSTs /new-version and opens the new draft (v1 stays published, AC-08.4).
// LD-140 (2026-11-13, binding): kit components only; [New template] is the page's one primary button; status = tone + icon + word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DataTable } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { useToast } from '@lims/ui/components/Toast';
import { newSynopticVersionAction, publishSynopticAction, retireSynopticAction } from '../../server/actions.config';
import type { TemplateSummary } from '../../server/config.types';
import { FailNotice, KIND_LABEL, When } from '../common';
import { cfgText, MfaDialog, newKey, TemplateStatusChip, type Fail } from './config-shared';

export function TemplatesTab({ templates }: { templates: readonly TemplateSummary[] }) {
  const router = useRouter();
  const toast = useToast();
  const busy = useRef(false);
  const [confirm, setConfirm] = useState<{ t: TemplateSummary; op: 'publish' | 'retire' }>();
  const [fail, setFail] = useState<Fail>();
  const [mfa, setMfa] = useState(false);

  const handle = (f: Fail) => (f.code === 'auth.mfa_required' ? setMfa(true) : setFail(f));
  const transition = async () => {
    if (!confirm) return;
    const { t, op } = confirm;
    setFail(undefined);
    const r = await (op === 'publish' ? publishSynopticAction : retireSynopticAction)(t.id, newKey());
    setConfirm(undefined);
    if (!r.ok) return handle(r);
    toast.show({ tone: 'success', title: op === 'publish' ? 'Template published' : 'Template retired' });
    router.refresh();
  };
  const newVersion = async (t: TemplateSummary) => {
    if (busy.current) return;
    busy.current = true;
    setFail(undefined);
    try {
      const r = await newSynopticVersionAction(t.id, newKey());
      if (!r.ok) return handle(r);
      router.push(`/anatomic/config/templates/${r.data.id}`);
    } finally {
      busy.current = false;
    }
  };

  return (
    <>
      <FailNotice fail={fail} describe={cfgText} />
      <div className="lims-page-actions">
        <a className="lims-btn lims-btn-primary lims-btn-md" href="/anatomic/config/templates/new">New template</a>
      </div>
      {templates.length === 0 ? (
        <EmptyState title="No templates yet." body="Create a synoptic checklist, then publish it to use it in reports." />
      ) : (
        <DataTable
          caption="Synoptic templates"
          density="compact"
          rows={templates}
          getRowId={(t) => t.id}
          emptyState={{ title: 'No templates yet.' }}
          columns={[
            { id: 'key', header: 'Key', cell: (t) => <a className="lims-link lims-mono" href={`/anatomic/config/templates/${t.id}`}>{t.template_key}</a> },
            { id: 'version', header: 'Version', align: 'end', cell: (t) => String(t.version_no) },
            { id: 'title', header: 'Title', isRowHeader: true, cell: (t) => t.title },
            { id: 'status', header: 'Status', cell: (t) => <TemplateStatusChip status={t.status} /> },
            { id: 'kinds', header: 'Case kinds', hideBelow: 'md', cell: (t) => t.applies_to_case_kinds.map((k) => KIND_LABEL[k]).join(', ') },
            { id: 'published', header: 'Published', hideBelow: 'md', cell: (t) => <When value={t.published_at} /> },
            {
              id: 'actions', header: 'Actions',
              cell: (t) => (
                <>
                  {t.status === 'draft' ? <Button size="sm" variant="ghost" onPress={() => setConfirm({ t, op: 'publish' })}>{`Publish ${t.template_key} v${t.version_no}`}</Button> : null}
                  {t.status === 'published' ? <Button size="sm" variant="ghost" onPress={() => void newVersion(t)}>{`New version of ${t.template_key}`}</Button> : null}
                  {t.status === 'published' ? <Button size="sm" variant="ghost" onPress={() => setConfirm({ t, op: 'retire' })}>{`Retire ${t.template_key} v${t.version_no}`}</Button> : null}
                </>
              ),
            },
          ]}
        />
      )}
      <ConfirmDialog
        title={confirm?.op === 'retire' ? 'Retire template' : 'Publish template'}
        confirmLabel={confirm?.op === 'retire' ? 'Retire' : 'Publish'}
        tone={confirm?.op === 'retire' ? 'danger' : 'default'}
        isOpen={confirm !== undefined}
        onCancel={() => setConfirm(undefined)}
        body={confirm?.op === 'retire' ? 'Retired templates are no longer offered for new reports. Reports that already used them are not changed.' : 'Once published, this template cannot be changed. You can create a new version later.'}
        onConfirm={transition}
      />
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}
