import { useId, type ReactNode } from 'react';

export interface PageShellProps {
  topBar: ReactNode;
  nav: ReactNode;
  children: ReactNode;
  help?: ReactNode;
  /** Support-session / offline banner slot. */
  banner?: ReactNode;
  'data-testid'?: string;
}

export function PageShell({ topBar, nav, children, help, banner, ...rest }: PageShellProps) {
  const mainId = useId();
  return (
    <div className="lims-shell" {...rest}>
      <a className="lims-skip-link" href={`#${mainId}`}>
        Skip to main content
      </a>
      <header className="lims-shell-top">{topBar}</header>
      {banner ? <div className="lims-shell-banner">{banner}</div> : null}
      <div className="lims-shell-body">
        <nav className="lims-shell-nav" aria-label="Main">
          {nav}
        </nav>
        <main id={mainId} className="lims-shell-main" tabIndex={-1}>
          {children}
        </main>
        {help ? (
          <aside className="lims-shell-help" aria-label="Help">
            {help}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
