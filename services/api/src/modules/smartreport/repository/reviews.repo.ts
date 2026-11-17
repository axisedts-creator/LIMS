// smartreport.summary_reviews (05-SCHEMA §2.10) and smartreport.library_reviews (§2.7): class A, append-only history.
import { cols, insertRow, type RepoCtx, type Row } from './common.repo.js';

const SUMMARY_INS = cols('id centre_id summary_id action reason_code comment actor_membership_id');
const LIBRARY_INS = cols('id library_version_id action comment content_sha256 actor_membership_id');

export const insertSummaryReview = (rc: RepoCtx, row: Row) => insertRow(rc, 'smartreport.summary_reviews', SUMMARY_INS, row, false);
export const insertLibraryReview = (rc: RepoCtx, row: Row) => insertRow(rc, 'smartreport.library_reviews', LIBRARY_INS, row, false);
export async function listSummaryReviews(rc: RepoCtx, summaryId: string): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.summary_reviews WHERE tenant_id = $1 AND summary_id = $2 ORDER BY created_at ASC, id`, [rc.tenantId, summaryId])).rows;
}
export async function listLibraryReviews(rc: RepoCtx, libraryVersionId: string): Promise<Row[]> {
  return (await rc.tx.query(
    `SELECT * FROM smartreport.library_reviews WHERE tenant_id = $1 AND library_version_id = $2 ORDER BY created_at ASC, id`, [rc.tenantId, libraryVersionId])).rows;
}
