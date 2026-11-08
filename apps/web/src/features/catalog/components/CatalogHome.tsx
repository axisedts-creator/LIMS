'use client';
// SCR-01 Catalog home (04-UI-UX §4; 03-APP-FLOW §5). health === null = the load failed: tiles show "—", Reference + Retry.
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { StatTile } from '@lims/ui/components/StatTile';
import type { CatalogCounts, CatalogHealthReport } from '../server/types';

const has = (p: readonly string[], x: string) => p.includes(x);
const n = (v: number | undefined) => (v === undefined ? '—' : String(v));

// [CONV] filter params of the target lists (SCR-06 / SCR-13 define the filters).
const ATTENTION: { key: keyof CatalogHealthReport; label: string; href: string }[] = [
  { key: 'active_orderables_without_default_price', label: 'Active orderables without a default price', href: '/catalog/tests?health=without_default_price' },
  { key: 'analytes_without_reference_range', label: 'Analytes without a reference range', href: '/catalog/tests?health=without_reference_range' },
  { key: 'tests_without_specimen_type', label: 'Tests without a specimen type', href: '/catalog/tests?health=without_specimen_type' },
  { key: 'tests_missing_required_analyte', label: 'Tests missing their narrative/attachment analyte', href: '/catalog/tests?health=missing_required_analyte' },
  { key: 'unmapped_formula_inputs', label: 'Formulas referring to inactive analytes', href: '/catalog/tests?health=unmapped_formula_inputs' },
];

export function CatalogHome({ health, counts, revision, permissions, requestId }: {
  health: CatalogHealthReport | null;
  counts: CatalogCounts | null;
  revision: number | null;
  permissions: readonly string[];
  requestId?: string;
}) {
  const router = useRouter();
  const go = (href: string, label: string, primary = false) => (
    <Button key={href} variant={primary ? 'primary' : 'secondary'} onPress={() => router.push(href)}>
      {label}
    </Button>
  );
  const tests = has(permissions, 'catalog.test.read');
  const manage = has(permissions, 'catalog.test.manage');
  const canImport = manage || has(permissions, 'catalog.price_list.manage'); // kind-dependent import permissions (TRD §5.2 #97)
  const failed = health === null;
  const c = failed ? null : counts;
  const empty = !!c && c.departments === 0 && c.tests === 0;

  return (
    <section aria-label="Catalog">
      <PageHeader
        title="Catalog"
        helpKey="catalog.home"
        actions={
          <>
            {canImport ? go('/catalog/imports', 'Import from Excel') : null}
            {manage ? go('/catalog/tests?new=1', 'New test', true) : null}
          </>
        }
      />
      <div className="lims-stat-row">
        {tests ? <StatTile label="Tests (active)" value={n(c?.tests)} /> : null}
        {tests ? <StatTile label="Panels & packages" value={n(c?.panels)} /> : null}
        {has(permissions, 'catalog.referrer.read') ? <StatTile label="Doctors" value={c ? `${n(c.doctors)} (${n(c.doctors_unverified)} unverified)` : '—'} /> : null}
        {has(permissions, 'catalog.price_list.read') ? <StatTile label="Price lists" value={n(c?.price_lists)} /> : null}
        <StatTile label="Catalog revision" value={failed || revision === null ? '—' : String(revision)} />
      </div>
      {failed ? (
        <>
          <ErrorState title="The catalog summary could not be loaded." {...(requestId ? { requestId } : {})} onRetry={() => router.refresh()} />
          {tests ? (
            <section aria-labelledby="catalog-attention">
              <h2 id="catalog-attention">Needs attention</h2>
              <ul>
                {ATTENTION.map((a) => (
                  <li key={a.key}>
                    {a.label} <span>—</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : empty ? (
        <>
          <EmptyState title="No catalog yet. Import the starter workbook or create your first department." />
          <p>
            {canImport ? go('/catalog/imports', 'Import from Excel') : null}
            {manage ? go('/catalog/departments?new=1', 'New department', true) : null}
          </p>
        </>
      ) : tests ? (
        <section aria-labelledby="catalog-attention">
          <h2 id="catalog-attention">Needs attention</h2>
          {health.truncated ? <p role="note">Each check lists at most the first 200 items; there are more.</p> : null}
          <ul>
            {ATTENTION.map((a) => (
              <li key={a.key}>
                <a className="lims-link" href={a.href}>{`${a.label} (${(health[a.key] as readonly string[]).length})`}</a>
              </li>
            ))}
            <li>{`Tax default configured: ${health.tax_default_configured ? 'Yes' : 'No'}`}</li>
          </ul>
        </section>
      ) : null}
    </section>
  );
}
