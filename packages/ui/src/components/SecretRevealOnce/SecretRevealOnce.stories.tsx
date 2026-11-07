import { SecretRevealOnce } from './SecretRevealOnce';

export default { title: 'Data/SecretRevealOnce', component: SecretRevealOnce, args: { onAcknowledged: () => {} } };

export const Default = { args: { label: 'Enrolment code', secret: 'ENROL-7K2Q-ZZ81-SYNTH', expiresAt: '2026-11-06T04:15:00Z' } };
export const NoAcknowledgement = { args: { label: 'Setup key', secret: 'SYNTHKEY2345', requireAcknowledgement: false } };
