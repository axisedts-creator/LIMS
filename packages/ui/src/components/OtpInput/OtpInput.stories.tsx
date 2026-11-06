import { OtpInput } from './OtpInput';

export default { title: 'Fields/OtpInput', component: OtpInput, args: { label: '6-digit code', length: 6 } };

export const Default = {};
export const WithError = { args: { error: 'That code is not right. You have 4 tries left.' } };
