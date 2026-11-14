import type { ReactNode } from 'react';
import { Tab, TabList, TabPanel, Tabs as RacTabs } from 'react-aria-components';

export interface TabsProps {
  items: readonly { id: string; label: string; badge?: string; count?: number }[];
  selectedId: string;
  onChange: (id: string) => void;
  /** [CONV] Content of the selected tab; rendered in its tabpanel so aria-controls always resolves. */
  children?: ReactNode;
  /** Accessible name of the tab list. Default "Sections". */
  'aria-label'?: string;
  'data-testid'?: string;
}

export function Tabs({ items, selectedId, onChange, children, 'aria-label': ariaLabel = 'Sections', ...rest }: TabsProps) {
  return (
    <RacTabs className="lims-tabs" selectedKey={selectedId} onSelectionChange={(k) => onChange(String(k))} {...rest}>
      <TabList aria-label={ariaLabel} className="lims-tablist">
        {items.map((t) => (
          <Tab key={t.id} id={t.id} className="lims-tab">
            {t.label}
            {/* count pill, 0 shown (LD-140, 10-DESIGN-SYSTEM §4) */}
            {t.count !== undefined ? (
              <>
                {' '}
                <span className="lims-tab-badge">{t.count}</span>
              </>
            ) : null}
            {t.badge ? <span className="lims-tab-badge">{t.badge}</span> : null}
          </Tab>
        ))}
      </TabList>
      {items.map((t) => (
        <TabPanel key={t.id} id={t.id} className="lims-tabpanel">
          {t.id === selectedId ? children : null}
        </TabPanel>
      ))}
    </RacTabs>
  );
}
