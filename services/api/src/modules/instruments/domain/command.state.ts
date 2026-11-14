// Agent command machine (03-APP-FLOW §2.5). Pure.
import { LimsError } from '../../../core/errors.js';

export const COMMAND_STATES = ['queued', 'delivered', 'completed', 'failed', 'expired'] as const;
export type CommandState = (typeof COMMAND_STATES)[number];
export type CommandAction = 'deliver' | 'complete' | 'fail' | 'expire';

const TABLE: Readonly<Record<CommandAction, Readonly<Partial<Record<CommandState, CommandState>>>>> = {
  // delivered -> delivered: re-sent in each heartbeat response until a result arrives (§2.5).
  deliver: { queued: 'delivered', delivered: 'delivered' },
  complete: { delivered: 'completed' },
  fail: { delivered: 'failed' },
  expire: { queued: 'expired', delivered: 'expired' },
};

export function commandNext(from: CommandState, action: CommandAction): CommandState {
  const to = TABLE[action]?.[from];
  if (!to) throw new LimsError('instruments.invalid_transition');
  return to;
}
