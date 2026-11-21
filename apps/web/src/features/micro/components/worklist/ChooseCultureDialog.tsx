'use client';
// Scan with several cultures on one specimen (04-UI-UX §2 "Scan behaviour"): Dialog "Choose a culture" listing test name + status.
// LD-140 (2026-11-13): kit components only. Names and codes are server text → text nodes (REQ-SEC-088).
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { Stack } from '@lims/ui/components/Stack';
import type { ScanResult } from '../../server/types';
import { CultureStatusChip } from './CultureStatusChip';

type Choice = Extract<ScanResult, { kind: 'choose' }>['cultures'][number];

export function ChooseCultureDialog({ cultures, onChoose, onClose }: { cultures: readonly Choice[]; onChoose: (id: string) => void; onClose: () => void }) {
  return (
    <Dialog title="Choose a culture" isOpen onClose={onClose} size="sm">
      {/* T0D-UIGUARD-1-MICRO (LD-436, LD-439): kit Stack with list semantics, no raw ul */}
      <Stack gap={2} role="list" aria-label="Cultures">
        {cultures.map((c) => (
          <div key={c.id} role="listitem">
            <Button variant="secondary" onPress={() => onChoose(c.id)}>
              <span>{c.test_name}</span> <CultureStatusChip status={c.status} />
            </Button>
          </div>
        ))}
      </Stack>
    </Dialog>
  );
}
