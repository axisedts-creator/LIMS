import 'server-only';
// SR-03 library list / SR-04 library editor (04-UI-UX SR-03, SR-04). Order: id shape -> permission -> API reads. API 404 on the version -> notFound().
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { LibraryList } from '../components/LibraryList';
import { LibraryEditor } from '../components/LibraryEditor';
import { ReviewPanel } from '../components/ReviewPanel';
import { WordingTerms } from '../components/WordingTerms';
import { UUID_RE, diffLibrary } from '../library';
import * as api from './library.server';

export async function libraryListPage() {
  await api.requireManage();
  return <LibraryList rows={(await api.listVersions()).slice(0, 50)} />;
}

export async function libraryEditorPage(id: string) {
  if (!UUID_RE.test(id ?? '')) notFound();
  await api.requireManage();
  try {
    const [version, blocks, rules, mappings, groups, organGroups, realOrder] = await Promise.all([
      api.getVersion(id), api.listBlocks(id), api.listRules(id), api.listMappings(id), api.listGroups(id), api.organGroups(), api.canReadResults(),
    ]);
    return <LibraryEditor key={version.version} version={{ ...version, id }} blocks={blocks} rules={rules} mappings={mappings} groups={groups} organGroups={organGroups} canPreviewOrder={realOrder} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

/** SR-05 review / approve. Order: id shape -> permission (manage or approve) -> reads. The candidate and the active version are the only versions read. */
export async function libraryReviewPage(id: string) {
  if (!UUID_RE.test(id ?? '')) notFound();
  const { canApprove } = await api.requireReview();
  try {
    const version = await api.getVersion(id);
    const [blocks, rules, mappings, groups, organGroups, a] = await Promise.all([
      api.listBlocks(id), api.listRules(id), api.listMappings(id), api.listGroups(id), api.organGroups(), api.activeVersion(),
    ]);
    const active = a && a.id !== id ? a : undefined;
    const [bb, br, bm] = active ? await Promise.all([api.listBlocks(active.id), api.listRules(active.id), api.listMappings(active.id)]) : [[], [], []];
    const diff = diffLibrary({ blocks: bb, rules: br, mappings: bm }, { blocks, rules, mappings });
    return (
      <LibraryEditor
        key={version.version} version={{ ...version, id }} blocks={blocks} rules={rules} mappings={mappings} groups={groups} organGroups={organGroups} canPreviewOrder={false}
        review={<ReviewPanel id={id} status={version.status} version={version.version} changeSummary={version.change_summary} diff={diff} hasActive={!!active} canApprove={canApprove} />}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}

export async function wordingPage() {
  await api.requireManage();
  return <WordingTerms rows={(await api.listTerms()).slice(0, 1000)} />;
}
