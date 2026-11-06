import { ImageThumbnailGrid } from './ImageThumbnailGrid';

export default { title: 'Data/ImageThumbnailGrid', component: ImageThumbnailGrid };

export const States = {
  args: {
    label: 'Case images',
    onSelect: () => {},
    images: [
      { id: 'a', src: '/bff/images/a/content', alt: 'Gross image 1', caption: 'Margin', state: 'ready' },
      { id: 'b', src: '/bff/images/b/content', alt: 'Gross image 2', state: 'processing' },
      { id: 'c', src: '/bff/images/c/content', alt: 'Gross image 3', state: 'quarantined' },
    ],
  },
};
