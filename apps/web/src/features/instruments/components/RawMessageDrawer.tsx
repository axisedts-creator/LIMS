'use client';
// SCR-10 raw panel (04-UI-UX §3): E36 on open, shown as text with control characters as badges, no copy (PHI). The parent mounts this only while the
// drawer is open, so closing unmounts it and drops the text; a load that finishes after the close is ignored. Every open is a new, audited read.
import { useEffect, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { CodeBlock } from '@lims/ui/components/CodeBlock';
import { Drawer } from '@lims/ui/components/Drawer';
import { getInstrumentMessageRawAction } from '../server/actions';

export function RawMessageDrawer({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  const [raw, setRaw] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void getInstrumentMessageRawAction(messageId).then((r) => {
      if (!live) return;
      if (r.ok) setRaw(r.data.raw_text_escaped);
      else setError(`Could not load the raw message (${r.code}).`);
    });
    return () => { live = false; setRaw(undefined); };
  }, [messageId]);

  return (
    <Drawer title="Raw message" isOpen onClose={onClose} width="lg">
      {error ? (
        <div role="alert">
          <Banner tone="danger" title={error} />
        </div>
      ) : raw === undefined ? (
        <p>Loading…</p>
      ) : (
        <CodeBlock label="Raw message" text={raw} renderControlChars allowCopy={false} wrap maxHeight={520} />
      )}
      <p className="lims-description">Viewing raw messages is recorded.</p>
    </Drawer>
  );
}
