'use client';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

export function Providers({ children }: { children: ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
