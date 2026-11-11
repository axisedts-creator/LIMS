'use client';
// SCR-06 General tab: edit test fields (#26, If-Match). workflow_type is locked once any analyte version is published [CONV].
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { updateTestAction } from '../server/actions';
import type { TestDto } from '../server/types';
import { errAt, FailBanner, PERM, type Fail } from './shared';

const WORKFLOWS = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'] as const;
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function TestGeneralForm({ test, departments, hasPublishedAnalyteVersion, permissions }: {
  test: TestDto;
  departments: readonly { id: string; name: string; is_active: boolean }[];
  hasPublishedAnalyteVersion: boolean;
  permissions: readonly string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const canEdit = permissions.includes(PERM.manage);
  const [name, setName] = useState(test.name);
  const [department, setDepartment] = useState(test.department_id);
  const [workflow, setWorkflow] = useState(test.workflow_type);
  const [order, setOrder] = useState<number | undefined>(test.report_order);
  const [orderable, setOrderable] = useState(test.is_orderable);
  const [active, setActive] = useState(test.is_active);
  const [fail, setFail] = useState<Fail>();
  const off = !canEdit;

  const submit = async () => {
    const diff = {
      ...(name !== test.name ? { name } : {}),
      ...(department !== test.department_id ? { department_id: department } : {}),
      ...(workflow !== test.workflow_type ? { workflow_type: workflow } : {}),
      ...(order !== undefined && order !== test.report_order ? { report_order: order } : {}),
      ...(orderable !== test.is_orderable ? { is_orderable: orderable } : {}),
      ...(active !== test.is_active ? { is_active: active } : {}),
    };
    if (Object.keys(diff).length === 0) return;
    const r = await updateTestAction(test.id, test.version, diff);
    if (r.ok) {
      setFail(undefined);
      toast.show({ tone: 'success', title: 'Test saved.' });
      router.refresh();
    } else setFail(r);
  };

  return (
    <Form onSubmit={submit} errorSummary={false}>
      {fail ? <FailBanner fail={fail} /> : null}
      <TextField label="Code" name="code" maxLength={32} value={test.code} isReadOnly isDisabled />
      <TextField label="Name" name="name" maxLength={200} isRequired isDisabled={off} value={name} onChange={setName} {...(errAt(fail, '/name') ? { error: errAt(fail, '/name')! } : {})} />
      <Select label="Department" name="department_id" isDisabled={off} value={department} onChange={setDepartment} options={departments.map((d) => ({ value: d.id, label: d.name, isDisabled: !d.is_active && d.id !== test.department_id }))} />
      <Select
        label="Workflow type"
        name="workflow_type"
        isDisabled={off || hasPublishedAnalyteVersion}
        value={workflow}
        onChange={setWorkflow}
        options={WORKFLOWS.map((w) => ({ value: w, label: label(w) }))}
        {...(hasPublishedAnalyteVersion ? { description: 'Fixed after the first published analyte version.' } : {})}
      />
      <IntegerField label="Report order" name="report_order" min={0} max={9999} isDisabled={off} {...(order !== undefined ? { value: order } : {})} onChange={setOrder} />
      <Checkbox label="Orderable" name="is_orderable" isDisabled={off} isSelected={orderable} onChange={setOrderable} />
      <Checkbox label="Active" name="is_active" isDisabled={off} isSelected={active} onChange={setActive} />
      {canEdit ? <Button type="submit" variant="primary" shortcut="Ctrl+Enter">Save</Button> : null}
    </Form>
  );
}
