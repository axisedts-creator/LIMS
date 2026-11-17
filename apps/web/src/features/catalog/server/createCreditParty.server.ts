import 'server-only';
import { CREDIT_PARTY } from './specs';
import { createOf, dropBlank } from './shared';
import type { CreditParty } from './types';

const create = createOf<CreditParty>('credit-parties', CREDIT_PARTY.create, CREDIT_PARTY.required);
/** Blank party_code = server assigns `CP{seq:5}`. */
export const createCreditParty = async (input: unknown, idempotencyKey?: string) => create(dropBlank(input, 'party_code'), idempotencyKey);
