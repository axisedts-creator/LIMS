// SCR-06…08 Test detail — server component. 404 (incl. another tenant's test) and non-UUID ids → notFound(); other errors → error.tsx.
// T0D-TESTMGMT-1 (LD-318): General = full Edit Test form (TestForm), ?tab=analytes&analyte=new|<id> = full parameter form (ParameterForm),
// ?tab=ranges&analyte=<id> = reference range manager (RangeManager). Critical limits keep RangesTab. No route added.
import { Stack } from '@lims/ui/components/Stack';
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { AnalytesTab } from '@/features/catalog/components/AnalytesTab';
import { ParameterForm } from '@/features/catalog/components/ParameterForm';
import { RangeManager } from '@/features/catalog/components/RangeManager';
import { RangesTab } from '@/features/catalog/components/RangesTab';
import { TestForm } from '@/features/catalog/components/TestForm';
import { TestHeader } from '@/features/catalog/components/TestHeader';
import { TAB_IDS, TestTabs, type TabId } from '@/features/catalog/components/TestTabs';
import { getAnalyte } from '@/features/catalog/server/getAnalyte.server';
import { getTest } from '@/features/catalog/server/getTest.server';
import { listDepartments, listMethods, listRangeSets, listSpecimenTypes, listUnits, listValueSets } from '@/features/catalog/server/lists.server';
import { listTestCategories } from '@/features/catalog/server/testMgmt.server';
import { UUID_RE, type AnalyteRow, type AnalyteVersion, type RangeSet, type TestDto } from '@/features/catalog/server/types';

type Sp = Readonly<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const draftOf = (sets: readonly RangeSet[]) => { const d = sets.find((s) => s.status === 'draft'); return d ? { id: d.id, version_no: d.version_no, version: d.version } : undefined; };

/** API Analyte (nested current_version) → the flat row the tab renders. */
function toRow(a: Record<string, any>, methodName: (id?: string) => string | undefined, rangeVersion: number | null | undefined): AnalyteRow {
  const cv = a['current_version'] as AnalyteVersion | undefined;
  return {
    id: a['id'], code: a['code'], name: a['name'], print_name: a['print_name'], report_subheading: a['report_subheading'], sort_order: a['sort_order'],
    result_type: cv?.result_type ?? 'numeric', unit_code: cv?.unit_code, decimals: cv?.decimals, method_name: methodName(cv?.method_id),
    formula_expression: cv?.formula_expression, range_set_version: rangeVersion, current_version_no: cv?.version_no,
    has_draft: !!a['draft_version_id'], is_active: a['is_active'], version: a['version'],
  };
}

export default async function TestPage({ params, searchParams }: { params: Promise<{ test_id: string }>; searchParams: Promise<Sp> }) {
  const { test_id } = await params;
  if (!UUID_RE.test(test_id)) notFound();
  const sp = await searchParams;
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  const test = await getTest(test_id).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  });

  const analyteParam = first(sp['analyte']);
  const tabParam = first(sp['tab']);
  const tab: TabId = (TAB_IDS as readonly string[]).includes(tabParam ?? '') ? (tabParam as TabId) : 'analytes';
  const analyteId = analyteParam && UUID_RE.test(analyteParam) ? analyteParam : undefined;
  const creating = analyteParam === 'new';

  const [departments, units, methods, valueSets, specimenTypes] = await Promise.all([listDepartments(), listUnits(), listMethods(), listValueSets(), listSpecimenTypes()]);
  const methodName = (id?: string) => methods.find((m) => m.id === id)?.name;
  const analytes = ((test['analytes'] as Record<string, any>[] | undefined) ?? []).filter((a) => a['is_active'] !== false);
  const hasPublished = analytes.some((a) => (a['current_version'] as AnalyteVersion | undefined)?.status === 'published');
  const codes = analytes.map((a) => String(a['code']));

  let body: React.ReactNode;
  if (tab === 'general') {
    const categories = await listTestCategories().catch(() => []);
    body = (
      <TestForm
        mode="edit"
        test={test}
        departments={departments}
        categories={categories}
        specimenTypes={specimenTypes.map((s) => ({ id: s.id, name: s.name, is_active: (s as { is_active?: boolean }).is_active ?? true }))}
        permissions={permissions}
        hasPublishedAnalyteVersion={hasPublished}
      />
    );
  } else if (tab === 'analytes' && creating) {
    body = <ParameterForm testId={test_id} analyte={null} siblings={codes} units={units} methods={methods} valueSets={valueSets} permissions={permissions} />;
  } else if (analyteId) {
    const [analyte, rangeSets, criticalSets] = await Promise.all([
      getAnalyte(analyteId).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }),
      listRangeSets('ranges', analyteId),
      listRangeSets('critical', analyteId),
    ]);
    const version = analyte.versions.find((v) => v.status === 'draft') ?? analyte.versions.find((v) => v.status === 'published') ?? analyte.versions[0];
    if (tab === 'analytes') {
      body = (
        <ParameterForm
          key={analyte.id}
          testId={test_id}
          analyte={analyte as unknown as Record<string, unknown>}
          siblings={codes.filter((c) => c !== analyte.code)}
          units={units}
          methods={methods}
          valueSets={valueSets}
          rangeDraft={draftOf(rangeSets)}
          criticalDraft={draftOf(criticalSets)}
          permissions={permissions}
        />
      );
    } else if (tab === 'ranges') {
      const unit = units.find((u) => u.code === version?.unit_code)?.display ?? version?.unit_code;
      body = <RangeManager key={analyte.id} analyte={{ id: analyte.id, code: analyte.code, name: analyte.name, unit }} sets={rangeSets} criticalSets={criticalSets} methods={methods} permissions={permissions} />;
    } else {
      const a = { id: analyte.id, code: analyte.code, ...(version?.unit_code ? { unit_code: version.unit_code } : {}) };
      const vs = valueSets.find((s) => s.code === version?.value_set_code);
      body = <RangesTab key={tab} analyte={a} kind="critical" sets={criticalSets} valueSet={vs} specimenTypes={specimenTypes} permissions={permissions} />;
    }
  } else {
    // Analytes list. The per-analyte range-set version needs one list call each; only the first 50 are resolved. [CONV] open point: add it to the Analyte DTO.
    const sets = await Promise.all(analytes.slice(0, 50).map((a) => listRangeSets('ranges', a['id']).catch(() => [] as RangeSet[])));
    const rows = analytes.map((a, i) => toRow(a, methodName, i < sets.length ? (sets[i]!.find((s) => s.status === 'published')?.version_no ?? null) : undefined));
    body = tab === 'analytes' ? <AnalytesTab testId={test_id} analytes={rows} permissions={permissions} /> : <p>Choose an analyte on the Analytes tab to edit its {tab === 'ranges' ? 'reference ranges' : 'critical limits'}.</p>;
  }

  return (
    <Stack gap={4}>
      <TestHeader test={test as TestDto} />
      <TestTabs testId={test_id} tab={tab} analyteId={analyteId}>{body}</TestTabs>
    </Stack>
  );
}
