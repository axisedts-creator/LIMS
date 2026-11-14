'use client';
// 03-APP-FLOW §4.5 step 3 "Choose AST panel" (M11 assignAstPanel, TRD §4.2). LD-140 (2026-11-13): kit components only. Saving without a choice lets the server pick the panel by
// precedence (organism, group, site); choosing one sends only { ast_panel_id } (S-05 strict body). The panel list is read when the dialog opens, not at page load.
// Idempotency-Key per attempt (useAttempt), If-Match "<isolate version>". No panel matches -> 400 common.validation_failed: the dialog stays open and says so.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { useToast } from '@lims/ui/components/Toast';
import { FailNotice } from '../common';
import { useAttempt } from '../../forms/useAttempt';
import { listAstPanelsAction } from '../../server/actions';
import { assignAstPanelAction } from '../../server/astActions';
import type { IsolateDto } from '../../server/types';
import { useLoad } from '../settings/useLoad';

export function AssignPanelDialog({ isolate, onClose }: { isolate: IsolateDto; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const attempt = useAttempt();
  const panels = useLoad(() => listAstPanelsAction(), 'ast_panels');
  const [panel, setPanel] = useState<string>();

  const submit = async () => {
    const data = await attempt.send((key) => assignAstPanelAction(isolate.id, isolate.version, panel ? { ast_panel_id: panel } : {}, key));
    if (!data) return;
    toast.show({ tone: 'success', title: `AST panel assigned to isolate ${isolate.isolate_seq}` });
    router.refresh();
    onClose();
  };

  return (
    <Dialog title="Choose AST panel" isOpen onClose={onClose} size="sm">
      <FailNotice fail={attempt.fail} />
      <Form onSubmit={submit}>
        <Select<string>
          label="Panel"
          name="ast_panel_id"
          placeholder="Let the system choose"
          description="Leave empty to use the panel that fits the organism and the culture site."
          {...(panel ? { value: panel } : {})}
          options={panels.rows.filter((p) => p.is_active).map((p) => ({ value: p.id, label: `${p.display} · version ${p.version_no}` }))}
          onChange={(v) => { setPanel(v); attempt.touch(); }}
        />
        <Inline gap={2}>
          <Button type="submit" variant="primary" shortcut="Ctrl+Enter" isLoading={attempt.busy}>
            Save
          </Button>
          <Button variant="ghost" onPress={onClose} isDisabled={attempt.busy}>
            Cancel
          </Button>
        </Inline>
      </Form>
    </Dialog>
  );
}
