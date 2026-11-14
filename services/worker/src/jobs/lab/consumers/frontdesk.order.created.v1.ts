// frontdesk.order.created.v1 -> lab order service (02-TRD §4.1, §7.2; 06 row T-06).
import { applyOrderCreated } from '../../../../../api/src/modules/lab/service/order.service.js';
import { orderConsumer } from './frontdesk.order.shared.js';

export const handle = orderConsumer(applyOrderCreated);
