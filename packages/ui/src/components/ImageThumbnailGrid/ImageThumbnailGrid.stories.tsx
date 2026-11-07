import { ImageThumbnailGrid } from './ImageThumbnailGrid';

export default { title: 'Data/ImageThumbnailGrid', component: ImageThumbnailGrid };

const items = [
  { id: 'a', src: '/bff/images/a/content', caption: 'Margin', state: 'ready' },
  { id: 'b', src: '/bff/images/b/content', state: 'scanning' },
  { id: 'c', src: '/bff/images/c/content', state: 'rejected' },
] as const;

export const States = { args: { items, captionMaxLength: 200, max: 12 } };
export const Editable = {
  args: { items, captionMaxLength: 200, max: 12, onCaptionChange: () => {}, onRemove: () => {}, onReorder: () => {} },
};
