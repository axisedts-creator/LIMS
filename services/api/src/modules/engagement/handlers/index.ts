// C16-T01 handler placeholders: one per operationId in contracts/openapi/engagement.yaml (core checkHandlers, 02-TRD §3.2, §5).
// Every placeholder refuses with common.service_unavailable (503) until its task replaces it; never a 2xx (REQ-SEC-099).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { authHandlers } from './auth.handlers.js';
import { bookableHandlers } from './bookable.handlers.js';
import { bookingHandlers } from './booking.handlers.js';
import { displayHandlers } from './display.handlers.js';
import { queueHandlers } from './queue.handlers.js';
import { reminderHandlers } from './reminder.handlers.js';
import { slotHandlers } from './slot.handlers.js';
import { settingsHandlers } from './settings.handlers.js';
import { tokenHandlers } from './token.handlers.js';

const notYet: Handler = async () => { throw new LimsError('common.service_unavailable'); };

const OPERATION_IDS = [
  'getPatientAppConfig', 'requestPatientOtp', 'verifyPatientOtp', 'getMyAccount', 'updateMyAccount', 'deleteMyAccount', 'listMyProfiles',
  'redeemLinkCode', 'redeemReportLink', 'createSelfRegistration', 'getSelfRegistration', 'updateMyProfile', 'removeMyProfile',
  'listMyOrders', 'getMyOrder', 'listMyReports', 'downloadMyReport', 'getMySmartSummary', 'listMyBookableItems', 'listMyBookingCentres',
  'listMyAvailableSlots', 'createMyBooking', 'listMyBookings', 'getMyBooking', 'cancelMyBooking', 'listMyAddresses', 'createMyAddress',
  'updateMyAddress', 'deactivateMyAddress', 'createPaymentRequest', 'getPaymentRequest', 'listMyNotifications', 'markMyNotificationsRead',
  'listMyMemberships', 'listMyEnquiries', 'createMyEnquiry', 'getMyEnquiry', 'replyMyEnquiry', 'listMyCodedSet',
  'listBookings', 'createBookingForPatient', 'getBooking', 'cancelBooking', 'checkInBooking', 'getSlotAvailability',
  'listSlotTemplates', 'createSlotTemplate', 'updateSlotTemplate', 'deactivateSlotTemplate', 'listSlotBlackouts', 'createSlotBlackout',
  'deactivateSlotBlackout', 'listBookableItems', 'upsertBookableItem', 'syncBookableItems',
  'listQueues', 'createQueue', 'listQueueDefinitions', 'updateQueue', 'listCounters', 'createCounter', 'listCounterDefinitions', 'updateCounter',
  'issueQueueToken', 'listQueueTokens', 'callNextQueueToken', 'recallQueueToken', 'startServingQueueToken', 'completeQueueToken',
  'skipQueueToken', 'cancelQueueToken', 'transferQueueToken', 'listQueueDisplays', 'pairQueueDisplay', 'revokeQueueDisplay', 'getQueueBoard',
  'issueLinkCode', 'revokeLinkCode', 'listPatientAppLinks', 'revokeAppLink',
  'listReminders', 'createReminder', 'cancelReminder', 'listFollowUpSuggestions',
  'listMembershipPlans', 'createMembershipPlan', 'updateMembershipPlan', 'enrolMembership', 'listPatientMemberships', 'lookupMembershipCard',
  'cancelMembership', 'listEnquiries', 'getEnquiry', 'replyEnquiry', 'closeEnquiry',
  'getEngagementSettings', 'updateEngagementSettings', 'listEngagementCodedSet',
] as const;

export const handlers: Readonly<Record<(typeof OPERATION_IDS)[number], Handler>> = Object.freeze({
  ...(Object.fromEntries(OPERATION_IDS.map((op) => [op, notYet])) as Record<(typeof OPERATION_IDS)[number], Handler>),
  ...settingsHandlers, // T-03: T1, T2, T3a, T3b
  ...queueHandlers, // T-Q1: Q1a-c, Q2a-c
  ...tokenHandlers, // T-Q2: Q3-Q7
  ...displayHandlers, // T-Q3: Q8, Q9
  ...reminderHandlers, // T-R1: R1-R3
  ...slotHandlers, // T-B2: S6-S11
  ...bookableHandlers, // T-B1: S12-S14
  ...authHandlers, // T-A2: E1, E2
  ...bookingHandlers, // T-B3: S1-S5
});
