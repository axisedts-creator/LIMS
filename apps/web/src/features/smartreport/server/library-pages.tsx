import 'server-only';
// SR-03 library list / SR-04 library editor (04-UI-UX SR-03, SR-04). Order: id shape -> permission -> API reads. API 404 on the version -> notFound().
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { LibraryList } from '../components/LibraryList';
import { LibraryEditor } from '../components/LibraryEditor';
import { UUID_RE } from '../library';
import * as api from './library.server';

export async function libraryListPage() {
  await api.requireManage();
  return <LibraryList rows={(await api.listVersions()).slice(0, 50)} />;
}

export async function libraryEditorPage(id: string) {
  if (!UUID_RE.test(id ?? '')) notFound();
  await api.requireManage();
  try {
    const [version, blocks, rules, mappings, groups, organGroups] = await Promise.all([
      api.getVersion(id), api.listBlocks(id), api.listRules(id), api.listMappings(id), api.listGroups(id), api.organGroups(),
    ]);
    return <LibraryEditor key={version.version} version={{ ...version, id }} blocks={blocks} rules={rules} mappings={mappings} groups={groups} organGroups={organGroups} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
}
