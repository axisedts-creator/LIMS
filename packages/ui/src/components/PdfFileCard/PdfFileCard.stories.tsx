import { PdfFileCard } from './PdfFileCard';

export default { title: 'Data/PdfFileCard', component: PdfFileCard, args: { fileName: 'scan-001.pdf', sizeBytes: 1048576, pageCount: 3 } };

export const Scanning = { args: { state: 'scanning' } };
export const Ready = { args: { state: 'ready' } };
export const Quarantined = { args: { state: 'quarantined' } };
export const Rejected = { args: { state: 'rejected', rejectReason: 'too_many_pages' } };
export const Confirmed = { args: { state: 'confirmed', confirmedBy: 'Asha Test', confirmedAt: '2026-11-06T04:15:00Z' } };
