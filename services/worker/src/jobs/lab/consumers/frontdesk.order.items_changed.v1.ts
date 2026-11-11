// frontdesk.order.items_changed.v1 -> lab order service (02-TRD §7.2; 06 row T-06).
import { applyOrderItemsChanged } from '../../../../../api/src/modules/lab/service/order.service.js';
import { orderConsumer } from './frontdesk.order.shared.js';

export const handle = orderConsumer(applyOrderItemsChanged);
