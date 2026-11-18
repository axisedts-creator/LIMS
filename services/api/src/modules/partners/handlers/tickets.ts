// T0B-MSGDESK-1 (LD-321): the 10 partner ticket operations of partners.yaml (T0C-MSGDESK-1) — thin handlers over service/ticket.service.ts.
import type { Handler } from '../../../core/module.js';
import { ticketHandlers as t } from '../service/ticket.service.js';

export const createPartnerTicket: Handler = t.createPartnerTicket;
export const listPartnerTickets: Handler = t.listPartnerTickets;
export const getPartnerTicket: Handler = t.getPartnerTicket;
export const replyPartnerTicket: Handler = t.replyPartnerTicket;
export const closePartnerTicket: Handler = t.closePartnerTicket;
export const reopenPartnerTicket: Handler = t.reopenPartnerTicket;
export const listMyPartnerTickets: Handler = t.listMyPartnerTickets;
export const createMyPartnerTicket: Handler = t.createMyPartnerTicket;
export const getMyPartnerTicket: Handler = t.getMyPartnerTicket;
export const replyMyPartnerTicket: Handler = t.replyMyPartnerTicket;
