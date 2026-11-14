import type { ReactNode } from 'react';
import '@lims/ui/fonts.css';
import '@lims/ui/kit.css';
import '@/core/shell/shell.css';
import { Providers } from '@/core/shell/Providers';

export const metadata = { title: 'LIMS' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
