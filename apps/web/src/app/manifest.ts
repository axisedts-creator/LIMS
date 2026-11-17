import type { MetadataRoute } from 'next';

// T0D-FAVICON-1 (LD-310): Metro Labs app icon. Colours from packages/ui/tokens/tokens.json
// (accent.default #005A52, neutral.0 #FFFFFF). 192 = app/icon.png, 512 = public/icon-512.png.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Metro Labs',
    short_name: 'Metro Labs',
    start_url: '/',
    display: 'standalone',
    theme_color: '#005A52',
    background_color: '#FFFFFF',
    icons: [
      { src: '/icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  };
}
