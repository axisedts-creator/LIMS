import { SecretRevealOnce } from './SecretRevealOnce';

export default { title: 'Data/SecretRevealOnce', component: SecretRevealOnce, args: { onDone: () => {} } };

export const Default = { args: { label: 'Enrolment code', value: 'ENROL-7K2Q-ZZ81-SYNTH' } };
export const NoAcknowledgement = { args: { label: 'Setup key', value: 'SYNTHKEY2345', requireAcknowledgement: false } };
