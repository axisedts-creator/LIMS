import type { ReactNode } from 'react';

// WEB-STYLE-1 (LD-198): centres the auth card on the neutral page background; presentation only.
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="lims-auth-page">{children}</div>;
}
