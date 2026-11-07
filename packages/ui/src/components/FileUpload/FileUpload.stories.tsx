import { FileUpload } from './FileUpload';

export default {
  title: 'Fields/FileUpload',
  component: FileUpload,
  args: { label: 'Attachment', name: 'attachment', accept: ['application/pdf', 'image/png'], onSelect: () => {} },
};

export const Default = {};
export const Multiple = { args: { multiple: true, maxFiles: 5, description: 'PDF or PNG, up to 15 MB each' } };
export const WithError = { args: { error: 'Attach the signed consent form', isRequired: true } };
export const Spreadsheet = { args: { label: 'Price list', name: 'price_list', accept: ['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] } };
