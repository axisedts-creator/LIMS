import { PdfFileCard } from './PdfFileCard';

export default { title: 'Data/PdfFileCard', component: PdfFileCard, args: { filename: 'scan-001.pdf', sizeBytes: 1048576, pageCount: 3 } };

// stateLabel copy is the caller's (C6 04-UI-UX:115-121).
export const Scanning = { args: { state: 'scanning', stateLabel: 'Checking the file for viruses…', tone: 'info' } };
export const Ready = { args: { state: 'ready', stateLabel: 'Ready. Open it and confirm it belongs to this patient.', tone: 'warning', onDownload: () => {} } };
export const Quarantined = { args: { state: 'quarantined', stateLabel: 'This file was blocked by the virus scanner and has been isolated.', tone: 'danger' } };
