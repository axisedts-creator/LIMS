// #23 listSmartDenyTerms, #24 createSmartDenyTerm, #25 deactivateSmartDenyTerm (02-TRD §5, §9.5; AC-18.2, AC-18.3). Permission smartreport.template.manage, tenant-wide.
// Global terms (class G) are listed read-only with no id/version, so they are not addressable; #25 only ever touches the caller's tenant rows.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Handler } from '../../../core/module.js';
import { normaliseForMatch } from '../domain/wording.js';
import { getDenyTerm, insertDenyTerm, listDenyTerms, listGlobalDenyTerms, updateDenyTerm } from '../repository/denyTerms.repo.js';
import type { Row } from '../repository/common.repo.js';
import { authorise, invalidField, isObj, type SrCtx } from './shared.js';

const MANAGE = 'smartreport.template.manage';
const LANGUAGES = ['en', 'ne', 'any'];
const BODY_KEYS = ['term', 'language', 'reason'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const len = (s: string): number => [...s].length;

/** DenyTerm DTO: no tenant_id / term_folded / audit columns; null reason is omitted; global terms carry no id/version. */
const dto = (r: Row, scope: 'tenant' | 'global'): Row => ({
  ...(scope === 'tenant' ? { id: r.id } : {}), term: r.term, language: r.language, scope,
  ...(typeof r.reason === 'string' ? { reason: r.reason } : {}), is_active: r.is_active, ...(scope === 'tenant' ? { version: r.version } : {}),
});

export const listSmartDenyTerms: Handler = async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  const flag = isObj(req.query) ? req.query.include_global : undefined;
  if (flag !== undefined && flag !== true && flag !== false && flag !== 'true' && flag !== 'false') throw invalidField('include_global');
  const data = (await listDenyTerms(rc)).map((r) => dto(r, 'tenant'));
  if (flag === true || flag === 'true') data.push(...(await listGlobalDenyTerms(rc)).map((r) => dto(r, 'global')));
  return { status: 200, body: { data } };
};

export const createSmartDenyTerm: Handler = async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  const b = req.body;
  if (!isObj(b) || Object.keys(b).some((k) => !BODY_KEYS.includes(k))) throw invalidField('body');
  const { term, language, reason } = b;
  if (typeof term !== 'string') throw invalidField('term');
  const nfc = term.normalize('NFC');
  const folded = normaliseForMatch(nfc);
  if (len(nfc) < 2 || len(nfc) > 60 || len(folded) < 1 || len(folded) > 60) throw invalidField('term');
  if (typeof language !== 'string' || !LANGUAGES.includes(language)) throw invalidField('language');
  if (reason !== undefined && (typeof reason !== 'string' || len(reason) > 200)) throw invalidField('reason');
  const row = await insertDenyTerm(rc, { id: uuidv7(), term: nfc, term_folded: folded, language, ...(reason !== undefined ? { reason } : {}) });
  return { status: 201, body: dto(row, 'tenant') };
};

/** If-Match "<version>" (02-CV §4.2): absent -> 428; malformed -> 400. */
function parseIfMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2_147_483_647) throw invalidField('If-Match');
  return Number(m[1]);
}

export const deactivateSmartDenyTerm: Handler = async (req, ctx) => {
  const rc = await authorise(ctx as SrCtx, MANAGE);
  const version = parseIfMatch(req.headers);
  const id = isObj(req.params) ? req.params.term_id : undefined;
  if (typeof id !== 'string' || !UUID.test(id) || (await getDenyTerm(rc, id)) === null) throw new LimsError('common.not_found');
  return { status: 200, body: dto(await updateDenyTerm(rc, id, version, { is_active: false }), 'tenant') };
};
