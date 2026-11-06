import { MoneyText } from './MoneyText';

export default { title: 'Data/MoneyText', component: MoneyText, args: { value: { amountPaisa: 123456789, currency: 'NPR' } } };

export const Lakh = {};
export const International = { args: { grouping: 'international' } };
