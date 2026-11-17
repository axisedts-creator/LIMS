import 'server-only';
import { CREDIT_PARTY } from './specs';
import { updateOf } from './shared';
import type { CreditParty } from './types';

export const updateCreditParty = updateOf<CreditParty>('credit-parties', CREDIT_PARTY.patch);
