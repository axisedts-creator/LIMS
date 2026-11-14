// SCR-06 Tests list — server component; rows link to the detail page. Cursor paging via ?cursor= (CV §4.3).
import { Stack } from '@lims/ui/components/Stack';
import { getShellSession } from '@/core/session/server';
import { listTests } from '@/features/catalog/server/listTests.server';

const PERMISSION = 'catalog.test.read';

export default async function TestsPage({ searchParams }: { searchParams: Promise<Readonly<Record<string, string | string[] | undefined>>> }) {
  const sp = await searchParams;
  const session = await getShellSession();
  if (!session?.actor.permissions.includes(PERMISSION)) return <p>{`You need the ${PERMISSION} permission to see tests.`}</p>;
  const cursor = typeof sp['cursor'] === 'string' ? sp['cursor'] : undefined;
  const { data, page } = await listTests(cursor);
  return (
    <Stack gap={3}>
      <h1 className="lims-page-title">Tests</h1>
      {data.length === 0 ? (
        <p>No tests yet.</p>
      ) : (
        <table className="lims-table" aria-label="Tests">
          <thead>
            <tr>{['Code', 'Name', 'Workflow type', 'Status'].map((h) => <th key={h} scope="col">{h}</th>)}</tr>
          </thead>
          <tbody>
            {data.map((t) => (
              <tr key={t.id}>
                <td><a href={`/catalog/tests/${t.id}`}>{t.code}</a></td>
                <td>{t.name}</td>
                <td>{t.workflow_type ?? ''}</td>
                <td>{t.is_active ? 'Active' : 'Inactive'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {page.next_cursor ? <a href={`/catalog/tests?cursor=${encodeURIComponent(page.next_cursor)}`}>Next</a> : null}
    </Stack>
  );
}
