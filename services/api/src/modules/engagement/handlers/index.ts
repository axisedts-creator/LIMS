// C16-T01 handler placeholders: one per operationId in contracts/openapi/engagement.yaml (core checkHandlers, 02-TRD §3.2, §5).
// Every placeholder refuses with common.service_unavailable (503) until its task replaces it; never a 2xx (REQ-SEC-099).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { accountHandlers } from './account.handlers.js';
import { authHandlers } from './auth.handlers.js';
import { bookableHandlers } from './bookable.handlers.js';
import { bookingHandlers } from './booking.handlers.js';
import { displayHandlers } from './display.handlers.js';
import { enquiryHandlers } from './enquiry.handlers.js';
import { linkHandlers } from './link.handlers.js';
import { membershipHandlers } from './membership.handlers.js';
import { myBookingHandlers } from './mybooking.handlers.js';
import { notificationHandlers } from './notification.handlers.js';
import { ordersHandlers } from './orders.handlers.js';
import { paymentHandlers } from './payment.handlers.js';
import { queueHandlers } from './queue.handlers.js';
import { reportHandlers } from './report.handlers.js';
import { reminderHandlers } from './reminder.handlers.js';
import { selfregHandlers } from './selfreg.handlers.js';
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
  ...accountHandlers, // T-AC1: E10-E12
  ...bookingHandlers, // T-B3: S1-S5
  ...membershipHandlers, // T-M1: M1a-M5, E47
  ...linkHandlers, // T-L1: L1-L4, T-L2: E14, T-L3: E15
  ...selfregHandlers, // T-L4: E16, E17
  ...notificationHandlers, // T-P5: E45, E46
  ...enquiryHandlers, // T-N1: E48-E51, N1-N4
  ...ordersHandlers, // T-P2: E20, E21
  ...reportHandlers, // T-P3: E22, E23
  ...myBookingHandlers, // T-BK1: E30-E40
  ...paymentHandlers, // T-PAY1: E41, E42
});
