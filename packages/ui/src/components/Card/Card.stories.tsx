import { Card } from './Card';

export default { title: 'Layout/Card', component: Card };

export const WithTitle = { args: { title: 'Patient', children: 'सुनिता श्रेष्ठ' } };
export const WithCaption = { args: { title: 'Needs you', caption: '5 things waiting', children: 'Card body' } };
export const Plain = { args: { children: 'Card body' } };
