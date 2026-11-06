import { OtpInput } from './OtpInput';

export default { title: 'Fields/OtpInput', component: OtpInput, args: { label: '6-digit code', name: 'otp' } };

export const Default = {};
export const WithError = { args: { error: 'That code is not right. You have 4 tries left.' } };
