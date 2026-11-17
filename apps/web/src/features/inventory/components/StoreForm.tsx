'use client';
// S4 store form (04-UI-UX §3 S4). Create sends branch + code + name + kind + default flag; edit sends ONLY changed fields
// (branch_id and store_code are create-only). Moving the default flag is ONE PATCH on the new store; the server clears the old one (AC-03.1).
// LD-140: kit components only; Deactivate asks for confirmation.
import { useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { CodeField } from '@lims/ui/components/CodeField';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { Form } from '@lims/ui/components/Form';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { createStoreAction, updateStoreAction } from '../server/actions';
import type { ActionResult, Branch, Store, StoreKind, StorePatch } from '../server/types';
import { STORE_CODE, STORE_KINDS } from './codes';
import { ProblemBanner, useIdemKey, type Failure } from './shared';

const HELP = 'Tests and QC from analysers without their own store are deducted here.';

export function StoreForm({ store, branches, onDone }: { store?: Store; branches: readonly Branch[]; onDone: () => void }) {
  const [branchId, setBranchId] = useState<string>();
  const [code, setCode] = useState(store?.store_code ?? '');
  const [name, setName] = useState(store?.name ?? '');
  const [kind, setKind] = useState<StoreKind>(store?.store_kind ?? 'main');
  const [isDefault, setIsDefault] = useState(store?.is_default_consumption ?? false);
  const [problem, setProblem] = useState<Failure>();
  const [confirm, setConfirm] = useState(false);
  const key = useIdemKey();
  const orig = useRef(store);

  const finish = (r: ActionResult<true>) => {
    if (!r.ok) return setProblem(r);
    key.reset();
    onDone();
  };
  const onSubmit = async () => {
    setProblem(undefined);
    const o = orig.current;
    if (!o) return finish(await createStoreAction({ branch_id: branchId ?? '', store_code: code, name: name.trim(), store_kind: kind, is_default_consumption: isDefault }, key.get()));
    const patch: StorePatch = {};
    if (name.trim() !== o.name) patch.name = name.trim();
    if (kind !== o.store_kind) patch.store_kind = kind;
    if (isDefault !== o.is_default_consumption) patch.is_default_consumption = isDefault;
    if (Object.keys(patch).length === 0) return onDone();
    finish(await updateStoreAction(o.id, o.version, patch));
  };
  const setActive = async (active: boolean) => {
    const o = orig.current!;
    setConfirm(false);
    setProblem(undefined);
    finish(await updateStoreAction(o.id, o.version, { is_active: active }));
  };

  return (
    <>
      <Form onSubmit={onSubmit} {...(problem?.errors ? { problem: { errors: problem.errors } } : {})}>
        <Stack>
          <ProblemBanner problem={problem} />
          {store ? (
            <TextField label="Branch" name="branch_name" maxLength={200} isReadOnly value={store.branch_name} />
          ) : (
            <Select label="Branch" name="branch_id" isRequired options={branches.map((b) => ({ value: b.branch_id, label: `${b.code} — ${b.name}` }))} {...(branchId ? { value: branchId } : {})} onChange={setBranchId} />
          )}
          <CodeField label="Code" name="store_code" maxLength={16} pattern={STORE_CODE} patternHint="Letters A–Z, digits, _ - (start with a letter or digit, up to 16)" isRequired isReadOnly={!!store} value={code} onChange={setCode} />
          <TextField label="Name" name="name" maxLength={120} isRequired value={name} onChange={setName} />
          <Select label="Kind" name="store_kind" isRequired options={STORE_KINDS} value={kind} onChange={(v) => setKind(v as StoreKind)} />
          <Switch label="Default consumption" name="is_default_consumption" isSelected={isDefault} onChange={setIsDefault} />
          <p className="lims-description">{HELP}</p>
          <Inline justify="between">
            {store ? (
              store.is_active ? (
                <Button onPress={() => setConfirm(true)}>Deactivate</Button>
              ) : (
                <Button onPress={() => void setActive(true)}>Activate</Button>
              )
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary">
              Save
            </Button>
          </Inline>
        </Stack>
      </Form>
      <ConfirmDialog
        title="Deactivate store?"
        body="The store must be empty. Deactivating hides it from pickers; history is kept."
        confirmLabel="Deactivate"
        tone="danger"
        isOpen={confirm}
        onCancel={() => setConfirm(false)}
        onConfirm={() => setActive(false)}
      />
    </>
  );
}
