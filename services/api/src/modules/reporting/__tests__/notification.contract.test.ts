// C6-T19 — 03-IC §4.8 contract cases (1)-(12) against the REAL implementation (AC-16.1; 02-TRD §14 "runNotificationPortContract against the real impl").
// The C0 suite is reused unchanged; only the harness is ours (notification.helpers.ts: in-memory SQL fake + real core events/rate limiter + C0 Frontdesk fake).
import { runNotificationPortContract } from '../../../../../../packages/fakes/contract-tests/NotificationPort.contract.js';
import { makeNotifWorld } from './notification.helpers.js';

runNotificationPortContract(async () => makeNotifWorld().harness as any);
