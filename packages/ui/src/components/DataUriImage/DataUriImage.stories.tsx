import { DataUriImage } from './DataUriImage';

export default { title: 'Data/DataUriImage', component: DataUriImage };

export const Png = {
  args: { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', alt: 'QR code for your authenticator app' },
};
export const Rejected = { args: { src: '/api/qr.png', alt: 'Not rendered' } };
